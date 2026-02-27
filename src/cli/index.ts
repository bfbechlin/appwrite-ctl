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
import {
  loadSecurityLedger,
  saveSecurityLedger,
  resolveAuthor,
  DEFAULT_RULES,
} from '../lib/security.js';

const program = new Command();

const generateDocs = (snapshotPath: string, version: string, outputDir: string): void => {
  if (!fs.existsSync(snapshotPath)) return;

  const markdown = generateSchemaDoc(snapshotPath, version);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, 'docs.md');
  fs.writeFileSync(outputPath, markdown);
  console.log(chalk.green(`Docs updated at ${outputPath}`));
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
    const ctlConfigPath = path.join(appwriteDir, 'appwrite-ctl.config.json');

    if (!fs.existsSync(appwriteDir)) fs.mkdirSync(appwriteDir);
    if (!fs.existsSync(migrationDir)) fs.mkdirSync(migrationDir);

    if (!fs.existsSync(ctlConfigPath)) {
      const config = {
        collection: 'migrations',
        database: 'system',
        security: {
          rules: DEFAULT_RULES,
          exceptions: {},
        },
      };
      fs.writeFileSync(ctlConfigPath, JSON.stringify(config, null, 2) + '\n');
      console.log(chalk.green('Created appwrite/appwrite-ctl.config.json'));
    } else {
      console.log(chalk.yellow('appwrite-ctl.config.json already exists — not overwritten.'));
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

    // Snapshot logic: always pull from Appwrite via CLI for a new migration.
    console.log(chalk.blue('Pulling latest schema from Appwrite via CLI...'));

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

    console.log(chalk.green(`Created migration v${nextVersion} at ${versionPath}`));

    generateDocs(path.join(versionPath, snapshotFilename), `v${nextVersion}`, versionPath);
    generateDocs(
      path.join(versionPath, snapshotFilename),
      `v${nextVersion}`,
      path.join(process.cwd(), 'appwrite'),
    );
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

      const snapshotFilename = getSnapshotFilename();
      generateDocs(path.join(versionPath, snapshotFilename), version, versionPath);
      console.log(chalk.green(`Successfully updated docs.md for ${version}`));
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

program
  .command('docs [version]')
  .description(
    'Generate schema documentation with ER diagrams. Optionally pass a version (e.g. v1) to ' +
      'generate docs from a stored snapshot instead of pulling from Appwrite.',
  )
  .action(async (version?: string) => {
    try {
      const options = program.opts();
      const appwriteDir = path.join(process.cwd(), 'appwrite');

      if (version) {
        // Use stored snapshot for the given version without hitting Appwrite.
        const versionPath = path.join(appwriteDir, 'migration', version);
        if (!fs.existsSync(versionPath)) {
          console.error(chalk.red(`Version directory '${version}' not found.`));
          process.exit(1);
        }
        const snapshotFilename = getSnapshotFilename();
        const snapshotPath = path.join(versionPath, snapshotFilename);
        if (!fs.existsSync(snapshotPath)) {
          console.error(chalk.red(`No snapshot found for ${version}.`));
          process.exit(1);
        }
        console.log(chalk.blue(`Generating docs from stored snapshot for ${version}...`));
        generateDocs(snapshotPath, version, appwriteDir);
        generateDocs(snapshotPath, version, versionPath);
      } else {
        const config = loadConfig(options.env);

        console.log(chalk.blue(`Pulling latest schema from Appwrite to project root...`));
        await configureClient(config);

        const snapshotPath = await pullSnapshot();

        console.log(chalk.blue('Generating documentation...'));
        generateDocs(snapshotPath, 'latest', appwriteDir);

        // Cleanup the temporary snapshot pulled to root
        if (fs.existsSync(snapshotPath)) {
          fs.unlinkSync(snapshotPath);
        }
      }
    } catch (error: any) {
      console.error(chalk.red('Docs generation failed:'), error.message);
      process.exit(1);
    }
  });

const RESOURCE_TYPES = ['Collection', 'Bucket'] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

const exceptions = program
  .command('exceptions')
  .description('Manage security exception entries in security.json');

exceptions
  .command('add')
  .description('Interactively add a new security exception entry to appwrite/security.json')
  .action(async () => {
    const { default: inquirer } = await import('inquirer');

    const appwriteDir = path.join(process.cwd(), 'appwrite');
    const ledger = loadSecurityLedger(appwriteDir);
    const author = resolveAuthor();
    const today = new Date().toISOString().split('T')[0];

    console.log(chalk.blue(`Author resolved as: ${chalk.bold(author)}`));

    const answers = await inquirer.prompt<{
      resourceType: ResourceType;
      resourceId: string;
      rule: string;
      justification: string;
    }>([
      {
        type: 'list',
        name: 'resourceType',
        message: 'Resource type:',
        choices: RESOURCE_TYPES,
      },
      {
        type: 'input',
        name: 'resourceId',
        message: 'Resource ID (collection/bucket ID):',
        validate: (v: string) => v.trim().length > 0 || 'Resource ID is required.',
      },
      {
        // Use a list picker when rules are configured, otherwise free text
        type: Object.keys(ledger.rules ?? {}).length > 0 ? 'list' : 'input',
        name: 'rule',
        message: 'Rule being bypassed:',
        choices: Object.keys(ledger.rules ?? {}),
        validate: (v: string) => v.trim().length > 0 || 'Rule is required.',
      },
      {
        type: 'input',
        name: 'justification',
        message: 'Technical justification:',
        validate: (v: string) => v.trim().length > 0 || 'Justification is required.',
      },
    ]);

    const type = answers.resourceType === 'Collection' ? 'collections' : 'buckets';

    if (!ledger.exceptions[type]) ledger.exceptions[type] = {};
    const bucket = ledger.exceptions[type]!;
    if (!bucket[answers.resourceId]) bucket[answers.resourceId] = [];

    bucket[answers.resourceId].push({
      rule: answers.rule.trim(),
      justification: answers.justification.trim(),
      author,
      date: today,
    });

    saveSecurityLedger(appwriteDir, ledger);
    console.log(
      chalk.green(`\n✅ Exception recorded in appwrite/security.json by '${author}' on ${today}.`),
    );
  });

exceptions
  .command('list')
  .description('List all security exceptions recorded in appwrite/security.json')
  .action(() => {
    const appwriteDir = path.join(process.cwd(), 'appwrite');
    const ledger = loadSecurityLedger(appwriteDir);
    const { collections = {}, buckets = {} } = ledger.exceptions;

    const allEntries: Array<{
      type: string;
      id: string;
      rule: string;
      author: string;
      date: string;
      justification: string;
    }> = [];

    for (const [id, exs] of Object.entries(collections)) {
      for (const ex of exs) allEntries.push({ type: 'collection', id, ...ex });
    }
    for (const [id, exs] of Object.entries(buckets)) {
      for (const ex of exs) allEntries.push({ type: 'bucket', id, ...ex });
    }

    if (allEntries.length === 0) {
      console.log(chalk.yellow('No security exceptions recorded in appwrite/security.json.'));
      return;
    }

    console.log(chalk.bold.underline('\nSecurity Exceptions\n'));

    for (const entry of allEntries) {
      console.log(
        `${chalk.cyan(entry.type.padEnd(12))} ${chalk.bold(entry.id.padEnd(28))} ${chalk.yellow(entry.rule.padEnd(30))} ${chalk.gray(`${entry.author}, ${entry.date}`)}`,
      );
      console.log(`  ${chalk.italic(entry.justification)}`);
      console.log();
    }
  });

program.parse();
