#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
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

const program = new Command();

program.name('appwrite-ctl').description('Appwrite CLI for managing migrations and other operations');

program.option('-e, --env <path>', 'Path to environment file', '.env');

const migrations = program.command('migrations').description('Manage Appwrite migrations');

migrations
  .command('init')
  .description('Initialize the migrations project structure')
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
  .command('create <name>')
  .description('Create a new migration version')
  .action(async (name) => {
    const migrationsDir = path.join(process.cwd(), 'appwrite', 'migration');

    // Find next version number or use timestamp? Requirement says "vX".
    // "Discovery: Varre ... ordena ... alfabeticamente"
    // "create <name>: Gera uma nova pasta de versão"
    // Usually v1, v2...
    // Let's check existing folders.
    const versionDirs = fs
      .readdirSync(migrationsDir)
      .filter(
        (dir) => dir.startsWith('v') && fs.statSync(path.join(migrationsDir, dir)).isDirectory(),
      )
      .map((d) => parseInt(d.substring(1)))
      .sort((a, b) => a - b);

    const nextVersion = (versionDirs.length > 0 ? versionDirs[versionDirs.length - 1] : 0) + 1;
    const versionPath = path.join(migrationsDir, `v${nextVersion}`);

    fs.mkdirSync(versionPath);

    const indexContent = `import { Migration } from "appwrite-migrations";

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

    // Copy snapshot (appwrite.json) from previous version or root?
    // "copia o snapshot mais recente para a nova pasta"
    // If v(N-1) exists, copy from there. use root appwrite.json if not.
    let sourceJson = path.join(process.cwd(), 'appwrite.json');
    if (versionDirs.length > 0) {
      const lastVersionPath = path.join(
        migrationsDir,
        `v${versionDirs[versionDirs.length - 1]}`,
        'appwrite.json',
      );
      if (fs.existsSync(lastVersionPath)) {
        sourceJson = lastVersionPath;
      }
    }

    if (fs.existsSync(sourceJson)) {
      fs.copyFileSync(sourceJson, path.join(versionPath, 'appwrite.json'));
      console.log(chalk.green(`Copied snapshot from ${sourceJson}`));
    } else {
      // Revert creation if snapshot fails? Or just Warn?
      // User says "Ao criar a migração um snapshot precisa ser buscado e colocado dentro da versão!"
      // So failing is appropriate if we can't get it.
      // But maybe user just initialized?
      console.error(chalk.red('Error: No appwrite.json found to copy as snapshot.'));
      console.error(
        chalk.yellow(
          'Please ensure you have an appwrite.json file in your project root or previous migrations.',
        ),
      );
      console.error(
        chalk.yellow(
          'You can generate one by running "appwrite init project" or "appwrite init collection" using the Appwrite CLI.',
        ),
      );

      // Cleanup
      fs.rmSync(versionPath, { recursive: true, force: true });
      process.exit(1);
    }

    console.log(chalk.green(`Created migration v${nextVersion} at ${versionPath}`));
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

      // We can't easily get the ID without reading the file, which might be slow if many.
      // But for status we should probably read them.
      // Or we can just list folders and assume order?
      // Requirement: "Lista o histórico de migrações aplicadas no banco vs arquivos locais."

      for (const version of versionDirs) {
        const indexPath = path.join(migrationsDir, version, 'index.ts'); // or .js
        // skipping full load for speed might be better but we need ID to match.
        // Regex?
        // Let's try to match ID from file content with regex to avoid executing code
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

program.parse();
