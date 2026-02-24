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

// Resource types to sync (excludes 'settings' which requires interactive login).
const RESOURCES = ['tables', 'buckets', 'teams', 'topics'];

/**
 * Pull a full snapshot from Appwrite into a target directory.
 * Uses individual `appwrite pull <resource>` commands for non-interactive operation.
 *
 * The operation works in the project root (where appwrite.config.json lives).
 * If a targetDir is provided, it copies the resulting file to the target directory and cleans up the root.
 */
export const pullSnapshot = async (targetDir?: string): Promise<string> => {
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

  if (targetDir && targetDir !== rootDir) {
    // Copy the updated root config into the target version directory
    const targetPath = path.join(targetDir, SNAPSHOT_FILENAME);
    fs.copyFileSync(rootConfig, targetPath);
    console.log(chalk.green(`Snapshot saved to ${targetPath}`));

    // Cleanup: Remove the root appwrite.config.json created by the pull command.
    if (fs.existsSync(rootConfig)) {
      fs.unlinkSync(rootConfig);
    }
    return targetPath;
  }

  console.log(chalk.green(`Snapshot saved to ${rootConfig}`));
  return rootConfig;
};

/**
 * Push a snapshot from a version directory to the Appwrite project.
 * Copies the version's appwrite.config.json to the project root,
 * then runs individual `appwrite push <resource> --all --force` commands.
 *
 * The `projectId` in the snapshot is rewritten to match the current config,
 * allowing the same snapshot to be pushed to any environment.
 *
 * `--all` auto-selects all resources, `--force` auto-confirms changes.
 */
export const pushSnapshot = async (snapshotPath: string, config: AppConfig): Promise<void> => {
  const rootDir = process.cwd();
  const rootConfig = path.join(rootDir, SNAPSHOT_FILENAME);

  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Snapshot not found: ${snapshotPath}`);
  }

  // Backup current root config before overwriting.
  const backupPath = rootConfig + '.bak';
  const originalExists = fs.existsSync(rootConfig);
  if (originalExists) {
    fs.copyFileSync(rootConfig, backupPath);
  }

  // Copy snapshot to root and rewrite projectId to match current environment.
  const snapshotData = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  snapshotData.projectId = config.projectId;
  fs.writeFileSync(rootConfig, JSON.stringify(snapshotData, null, 2));
  console.log(chalk.blue(`Snapshot copied to project root (projectId: ${config.projectId}).`));

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
    // Restore backup if push fails.
    if (originalExists && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, rootConfig);
      console.log(chalk.yellow('Root config restored from backup after push failure.'));
    }
    throw error;
  } finally {
    // Restore original state.
    if (originalExists) {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, rootConfig);
        fs.unlinkSync(backupPath);
      }
    } else {
      // If it didn't exist before, delete the one we created.
      if (fs.existsSync(rootConfig)) {
        fs.unlinkSync(rootConfig);
      }
    }
  }
};

/**
 * Get the snapshot filename used for versioned snapshots.
 */
export const getSnapshotFilename = (): string => SNAPSHOT_FILENAME;
