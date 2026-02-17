import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { AppConfig } from './config.js';

const execAsync = promisify(exec);

const SNAPSHOT_FILENAME = 'appwrite.config.json';

/**
 * Configure the Appwrite CLI client for non-interactive use via API key.
 */
export const configureClient = async (config: AppConfig): Promise<void> => {
  const args = [
    `--endpoint ${config.endpoint}`,
    `--project-id ${config.projectId}`,
    `--key ${config.apiKey}`,
  ];

  try {
    await execAsync(`appwrite client ${args.join(' ')}`);
    console.log(chalk.green('Appwrite CLI configured successfully.'));
  } catch (error: any) {
    throw new Error(
      `Failed to configure Appwrite CLI: ${error.message}. Ensure 'appwrite-cli' is installed.`,
      { cause: error },
    );
  }
};

// Resource types to sync (excludes 'settings' which requires interactive login)
const RESOURCES = ['tables', 'buckets', 'teams', 'topics'];

/**
 * Pull a full snapshot from Appwrite into a target directory.
 * Uses individual `appwrite pull <resource>` commands for non-interactive operation.
 *
 * The operation works in the project root (where appwrite.config.json lives),
 * then copies the resulting file to the target directory.
 */
export const pullSnapshot = async (targetDir: string): Promise<string> => {
  const rootDir = process.cwd();
  const rootConfig = path.join(rootDir, SNAPSHOT_FILENAME);

  for (const resource of RESOURCES) {
    console.log(chalk.blue(`Pulling ${resource}...`));
    try {
      await execAsync(`appwrite pull ${resource}`, { cwd: rootDir, timeout: 120_000 });
      console.log(chalk.green(`  ✓ ${resource}`));
    } catch (error: any) {
      console.warn(chalk.yellow(`  ⚠ Failed to pull ${resource}: ${error.message}`));
    }
  }

  if (!fs.existsSync(rootConfig)) {
    throw new Error(
      `appwrite.config.json not found at project root after pull. ` +
        `Ensure the CLI is configured correctly.`,
    );
  }

  // Copy the updated root config into the target version directory
  const targetPath = path.join(targetDir, SNAPSHOT_FILENAME);
  fs.copyFileSync(rootConfig, targetPath);
  console.log(chalk.green(`Snapshot saved to ${targetPath}`));

  return targetPath;
};

/**
 * Push a snapshot from a version directory to the Appwrite project.
 * Copies the version's appwrite.config.json to the project root,
 * then runs individual `appwrite push <resource> --all --force` commands.
 *
 * `--all` auto-selects all resources, `--force` auto-confirms changes.
 */
export const pushSnapshot = async (snapshotPath: string): Promise<void> => {
  const rootDir = process.cwd();
  const rootConfig = path.join(rootDir, SNAPSHOT_FILENAME);

  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Snapshot not found: ${snapshotPath}`);
  }

  // Backup current root config before overwriting
  const backupPath = rootConfig + '.bak';
  if (fs.existsSync(rootConfig)) {
    fs.copyFileSync(rootConfig, backupPath);
  }

  // Copy snapshot to root so CLI picks it up
  fs.copyFileSync(snapshotPath, rootConfig);
  console.log(chalk.blue('Snapshot copied to project root.'));

  try {
    for (const resource of RESOURCES) {
      console.log(chalk.blue(`Pushing ${resource}...`));
      try {
        const extraFlags = resource === 'tables' ? '--attempts 60' : '';
        await execAsync(`appwrite push ${resource} --all --force ${extraFlags}`.trim(), {
          cwd: rootDir,
          timeout: 300_000,
        });
        console.log(chalk.green(`  ✓ ${resource}`));
      } catch (error: any) {
        console.error(chalk.red(`  ✗ Failed to push ${resource}: ${error.message}`));
        throw error;
      }
    }
  } catch (error) {
    // Restore backup if push fails
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, rootConfig);
      console.log(chalk.yellow('Root config restored from backup after push failure.'));
    }
    throw error;
  } finally {
    // Clean up backup
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  }
};

/**
 * Get the snapshot filename used for versioned snapshots.
 */
export const getSnapshotFilename = (): string => SNAPSHOT_FILENAME;
