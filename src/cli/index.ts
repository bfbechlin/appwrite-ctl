#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';

import { runMigrations } from '../lib/runner.js';
import { loadConfig } from '../lib/config.js';
import {
  createAppwriteClient,
  ensureMigrationCollection,
  getAppliedMigrations,
} from '../lib/appwrite.js';
import { configureClient, pullSnapshot, getSnapshotFilename } from '../lib/cli.js';
import { generateSchemaDoc } from '../lib/diagram.js';

const program = new Command();

const generateDocs = (version?: string, outputDir?: string): void => {
  const migrationsDir = path.join(process.cwd(), 'appwrite', 'migration');
  const snapshotFilename = getSnapshotFilename();

  if (!fs.existsSync(migrationsDir)) return;

  // Resolve version: use provided or find latest
  if (!version) {
    const versionDirs = fs
      .readdirSync(migrationsDir)
      .filter(
        (dir) => dir.startsWith('v') && fs.statSync(path.join(migrationsDir, dir)).isDirectory(),
      )
      .map((d) => parseInt(d.substring(1)))
      .sort((a, b) => a - b);

    if (versionDirs.length === 0) return;
    version = `v${versionDirs[versionDirs.length - 1]}`;
  }

  const snapshotPath = path.join(migrationsDir, version, snapshotFilename);
  if (!fs.existsSync(snapshotPath)) return;

  const markdown = generateSchemaDoc(snapshotPath, version);
  const outputPath = path.join(outputDir ?? path.join(process.cwd(), 'appwrite'), 'schema.md');
  fs.writeFileSync(outputPath, markdown);
  console.log(chalk.green(`Schema docs updated at ${outputPath}`));
};

program
  .name('appwrite-ctl')
  .description('Appwrite CLI for managing migrations and other operations');

program.option('-e, --env <path>', 'Path to environment file', '.env');

program
  .command('init')
  .description('Initialize the project structure')
  .action(async () => {
    const rootDir = process.cwd();
    const appwriteDir = path.join(rootDir, 'appwrite');
    const migrationDir = path.join(appwriteDir, 'migration');
    const configPath = path.join(migrationDir, 'config.json');

    if (!fs.existsSync(appwriteDir)) fs.mkdirSync(appwriteDir);
    if (!fs.existsSync(migrationDir)) fs.mkdirSync(migrationDir);

    if (!fs.existsSync(configPath)) {
      const config = {
        collection: 'migrations',
        database: 'system',
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(chalk.green('Created appwrite/migration/config.json'));
    } else {
      console.log(chalk.yellow('Config file already exists.'));
    }

    console.log(chalk.green('Initialization complete.'));
  });

const migrations = program.command('migrations').description('Manage Appwrite migrations');

migrations
  .command('setup')
  .description('Create the system database and migrations collection in Appwrite')
  .action(async () => {
    try {
      const options = program.opts();
      const config = loadConfig(options.env);
      const { databases } = createAppwriteClient(config);
      await ensureMigrationCollection(databases, config);
      console.log(
        chalk.green(
          `System database '${config.database}' and collection '${config.migrationCollectionId}' ensured.`,
        ),
      );
    } catch (error: any) {
      console.error(chalk.red('Setup failed:'), error.message);
      process.exit(1);
    }
  });

migrations
  .command('create')
  .description('Create a new migration version')
  .action(async () => {
    const migrationsDir = path.join(process.cwd(), 'appwrite', 'migration');

    if (!fs.existsSync(migrationsDir)) {
      fs.mkdirSync(migrationsDir, { recursive: true });
    }
    const snapshotFilename = getSnapshotFilename();

    // Find next version number
    const versionDirs = fs
      .readdirSync(migrationsDir)
      .filter(
        (dir) => dir.startsWith('v') && fs.statSync(path.join(migrationsDir, dir)).isDirectory(),
      )
      .map((d) => parseInt(d.substring(1)))
      .sort((a, b) => a - b);

    const nextVersion = (versionDirs.length > 0 ? versionDirs[versionDirs.length - 1] : 0) + 1;
    const versionPath = path.join(migrationsDir, `v${nextVersion}`);
    const name = `migration_v${nextVersion}`;

    fs.mkdirSync(versionPath);

    const indexContent = `import { Migration } from "appwrite-ctl";

const migration: Migration = {
  id: "${uuidv4()}",
  description: "${name}",
  requiresBackup: false,
  up: async ({ client, databases, log, error }) => {
    log("Executing up migration for ${name}");
    // Write your migration logic here
  },
  down: async ({ client, databases, log, error }) => {
    log("Executing down migration for ${name}");
  }
};

export default migration;
`;

    fs.writeFileSync(path.join(versionPath, 'index.ts'), indexContent);

    // Snapshot logic: copy from previous version or from root appwrite.config.json.
    let snapshotSource: string | null = null;

    // First, try the previous version's snapshot.
    if (versionDirs.length > 0) {
      const lastVersionPath = path.join(
        migrationsDir,
        `v${versionDirs[versionDirs.length - 1]}`,
        snapshotFilename,
      );
      if (fs.existsSync(lastVersionPath)) {
        snapshotSource = lastVersionPath;
      }
    }

    // Fallback: root appwrite.config.json.
    if (!snapshotSource) {
      const rootConfig = path.join(process.cwd(), snapshotFilename);
      if (fs.existsSync(rootConfig)) {
        snapshotSource = rootConfig;
      }
    }

    if (snapshotSource) {
      fs.copyFileSync(snapshotSource, path.join(versionPath, snapshotFilename));
      console.log(chalk.green(`Copied snapshot from ${snapshotSource}`));
    } else {
      // No local snapshot - pull from Appwrite via CLI.
      console.log(chalk.blue('No previous snapshot found. Pulling from Appwrite via CLI...'));

      try {
        const options = program.opts();
        const config = loadConfig(options.env);
        await configureClient(config);
        await pullSnapshot(versionPath);
        console.log(chalk.green('Successfully pulled snapshot from Appwrite.'));
      } catch (error: any) {
        console.error(chalk.red(`Failed to pull snapshot: ${error.message}`));
        console.warn(chalk.yellow('Creating empty snapshot placeholder.'));

        const emptySnapshot = {
          projectId: '',
          projectName: '',
          settings: {},
          tablesDB: [],
          tables: [],
          buckets: [],
          teams: [],
          topics: [],
        };

        fs.writeFileSync(
          path.join(versionPath, snapshotFilename),
          JSON.stringify(emptySnapshot, null, 2),
        );
      }
    }

    console.log(chalk.green(`Created migration v${nextVersion} at ${versionPath}`));

    generateDocs(`v${nextVersion}`, versionPath);
  });

migrations
  .command('update <version>')
  .description('Update snapshot for a version by pulling current state from Appwrite via CLI')
  .action(async (version) => {
    const migrationsDir = path.join(process.cwd(), 'appwrite', 'migration');
    const versionPath = path.join(migrationsDir, version);

    if (!fs.existsSync(versionPath)) {
      console.error(chalk.red(`Version directory ${version} not found.`));
      process.exit(1);
    }

    console.log(chalk.blue(`Updating snapshot for ${version} via CLI pull...`));

    try {
      const options = program.opts();
      const config = loadConfig(options.env);

      await configureClient(config);
      await pullSnapshot(versionPath);

      console.log(chalk.green(`Successfully updated snapshot for ${version}`));

      generateDocs(version, versionPath);
    } catch (error: any) {
      console.error(chalk.red(`Failed to update snapshot: ${error.message}`));
      process.exit(1);
    }
  });

migrations
  .command('run')
  .description('Execute pending migrations')
  .action(async () => {
    try {
      const options = program.opts();
      await runMigrations(options.env);
    } catch (error: any) {
      console.error(chalk.red('Migration run failed:'), error.message);
      process.exit(1);
    }
  });

migrations
  .command('status')
  .description('List migration status')
  .action(async () => {
    try {
      const options = program.opts();
      const config = loadConfig(options.env);
      const { databases } = createAppwriteClient(config);
      const appliedIds = await getAppliedMigrations(databases, config);
      const appliedSet = new Set(appliedIds);

      const migrationsDir = path.join(process.cwd(), 'appwrite', 'migration');
      if (!fs.existsSync(migrationsDir)) {
        console.log('No migrations directory found.');
        return;
      }

      const versionDirs = fs
        .readdirSync(migrationsDir)
        .filter(
          (dir) => dir.startsWith('v') && fs.statSync(path.join(migrationsDir, dir)).isDirectory(),
        )
        .sort((a, b) => parseInt(a.substring(1)) - parseInt(b.substring(1)));

      console.log(chalk.bold.underline('\nMigration Status:\n'));

      for (const version of versionDirs) {
        const indexPath = path.join(migrationsDir, version, 'index.ts');
        let id = 'unknown';
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath, 'utf8');
          const match = content.match(/id:\s*["']([^"']+)["']/);
          if (match) id = match[1];
        }

        const status = appliedSet.has(id) ? chalk.green('APPLIED') : chalk.yellow('PENDING');
        console.log(`${version.padEnd(10)} [${id}] ${status}`);
      }
      console.log('');
    } catch (error: any) {
      console.error(chalk.red('Status check failed:'), error.message);
      process.exit(1);
    }
  });

migrations
  .command('docs [version]')
  .description('Generate schema documentation with ER diagrams from a migration snapshot')
  .action(async (version?: string) => {
    try {
      generateDocs(version);
    } catch (error: any) {
      console.error(chalk.red('Docs generation failed:'), error.message);
      process.exit(1);
    }
  });

program.parse();
