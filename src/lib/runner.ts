import { Databases } from 'node-appwrite';
import fs from 'fs';
import path from 'path';
import { createJiti } from 'jiti';
import { loadConfig } from './config.js';
import { createAppwriteClient, getAppliedMigrations, recordMigration } from './appwrite.js';
import { configureClient, pushSnapshot, getSnapshotFilename } from './cli.js';
import { Migration, MigrationContext } from '../types/index.js';
import chalk from 'chalk';

const jiti = createJiti(import.meta.url);

/**
 * Run pending migrations.
 */
export const runMigrations = async (envPath: string = '.env') => {
  const config = loadConfig(envPath);
  const { client, databases } = createAppwriteClient(config);

  console.log('Starting migration process...');

  // 0. Configure CLI with API key (non-interactive auth).
  console.log('Configuring Appwrite CLI...');
  await configureClient(config);

  // 1. Discovery.
  const migrationsDir = path.join(process.cwd(), 'appwrite', 'migration');
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found at ${migrationsDir}`);
    process.exit(1);
  }

  const versionDirs = fs
    .readdirSync(migrationsDir)
    .filter(
      (dir) => dir.startsWith('v') && fs.statSync(path.join(migrationsDir, dir)).isDirectory(),
    )
    .sort((a, b) => {
      const numA = parseInt(a.substring(1));
      const numB = parseInt(b.substring(1));
      return numA - numB;
    });

  console.log(`Found ${versionDirs.length} versions.`);

  // 2. State Check.
  const appliedMigrationIds = await getAppliedMigrations(databases, config);
  const appliedSet = new Set(appliedMigrationIds);

  const snapshotFilename = getSnapshotFilename();

  for (const version of versionDirs) {
    const versionPath = path.join(migrationsDir, version);
    const indexFile = path.join(versionPath, 'index.ts');
    const indexFileJs = path.join(versionPath, 'index.js');

    const validIndexFile = fs.existsSync(indexFile)
      ? indexFile
      : fs.existsSync(indexFileJs)
        ? indexFileJs
        : null;

    if (!validIndexFile) {
      console.warn(`Skipping ${version}: No index.ts or index.js found.`);
      continue;
    }

    // Load migration file using jiti.
    let migrationModule;
    try {
      migrationModule = await jiti.import(validIndexFile);
    } catch (loadError) {
      console.error(`Failed to load migration file ${validIndexFile}:`, loadError);
      process.exit(1);
    }

    const migration: Migration = (migrationModule as any).default;

    if (!migration || !migration.id) {
      console.error(`Invalid migration file in ${version}: Missing default export or id.`);
      process.exit(1);
    }

    if (appliedSet.has(migration.id)) {
      console.log(`Version ${version} (${migration.id}) already applied. Skipping.`);
      continue;
    }

    console.log(`Applying version ${version} (${migration.id})...`);

    // 3. Schema sync via CLI push.
    const snapshotPath = path.join(versionPath, snapshotFilename);
    if (fs.existsSync(snapshotPath)) {
      console.log(`Pushing schema snapshot for ${version}...`);
      try {
        await pushSnapshot(snapshotPath, config);
      } catch (error: any) {
        console.error('Schema push failed:', error.message);
        console.error("Ensure 'appwrite-cli' is installed and accessible.");
        process.exit(1);
      }
    } else {
      console.warn(`No ${snapshotFilename} found in ${version}. Skipping schema sync.`);
    }

    // 5. Attribute polling.
    if (fs.existsSync(snapshotPath)) {
      await waitForAttributes(databases, snapshotPath);
    }

    // 6. Data execution.
    console.log('Executing migration script...');
    const context: MigrationContext = {
      client,
      databases,
      log: (msg) => console.log(`[${version}] ${msg}`),
      error: (msg) => console.error(`[${version}] ${msg}`),
    };

    if (migration.up) {
      try {
        await migration.up(context);
      } catch (error) {
        console.error('Migration script failed:', error);
        process.exit(1);
      }
    }

    // 7. Finalization.
    console.log('Finalizing...');
    await recordMigration(databases, config, migration.id, version);

    console.log(`Version ${version} applied successfully.`);
  }

  console.log('All migrations applied.');
};

async function waitForAttributes(databases: Databases, snapshotPath: string) {
  console.log('Polling attribute status...');

  const MAX_ATTEMPTS = 60; // 60 × 2 s = 2-minute timeout per collection

  let schema: any;
  try {
    schema = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (e) {
    console.error('Failed to parse snapshot for attribute polling');
    return;
  }

  // appwrite.config.json format: tables[] with databaseId from tablesDB[].
  const tables = schema.tables || [];
  const tablesDB = schema.tablesDB || [];

  // Build a map of database $id -> database info.
  const dbMap = new Map<string, any>();
  for (const db of tablesDB) {
    dbMap.set(db.$id, db);
  }

  for (const table of tables) {
    const collectionId = table.$id;
    const databaseId = table.databaseId;

    if (!databaseId) {
      console.warn(`Table ${table.name} (${collectionId}) has no databaseId. Skipping polling.`);
      continue;
    }

    console.log(`Checking attributes for table ${table.name} (${collectionId})...`);

    let allAvailable = false;
    let attempts = 0;
    while (!allAvailable) {
      if (attempts >= MAX_ATTEMPTS) {
        console.warn(
          chalk.yellow(
            `  ⚠ Timed out waiting for attributes on ${collectionId} after ${MAX_ATTEMPTS} attempts. Proceeding anyway.`,
          ),
        );
        break;
      }
      attempts++;
      try {
        const response = await databases.listAttributes(databaseId, collectionId);
        const attributes = response.attributes;
        const pending = attributes.filter((attr: any) => attr.status !== 'available');

        if (pending.length === 0) {
          allAvailable = true;
        } else {
          console.log(`Waiting for ${pending.length} attributes to be available...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (e: any) {
        if (e.code === 500) {
          console.warn(
            chalk.red(
              `  ⚠ Failed to list attributes for ${collectionId} in DB ${databaseId}: Server Error. Skipping polling for this collection.`,
            ),
          );
          allAvailable = true; // Force exit loop
        } else {
          console.warn(
            `Failed to list attributes for ${collectionId} in DB ${databaseId}: ${e.message}. Retrying...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
  }
}
