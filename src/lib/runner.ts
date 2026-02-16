import { Databases } from 'node-appwrite';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { createJiti } from 'jiti';
import { AppConfig, loadConfig } from './config.js';
import { createAppwriteClient, getAppliedMigrations, recordMigration } from './appwrite.js';
import { Migration, MigrationContext } from '../types/index.js';

const execAsync = promisify(exec);
const jiti = createJiti(import.meta.url);

export const runMigrations = async (envPath: string = '.env') => {
  const config = loadConfig(envPath);
  const { client, databases } = createAppwriteClient(config);

  console.log('Starting migration process...');

  // 0. Auto-configure CLI
  console.log('Configuring Appwrite CLI based on environment variables...');
  try {
    if (config.endpoint && config.projectId && config.apiKey) {
      await execAsync(
        `appwrite client --endpoint ${config.endpoint} --project-id ${config.projectId} --key ${config.apiKey}`,
      );
      console.log('Appwrite CLI configured successfully.');
    } else {
      console.warn('Skipping CLI configuration due to missing environment variables.');
    }
  } catch (error) {
    console.warn(
      "Failed to configure Appwrite CLI automatically. Ensure 'appwrite' is installed and environment variables are set.",
    );
    // console.warn(error);
  }

  // 1. Discovery
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
      // simple alphanum sort, expects v1, v2, v10 etc to be sorted correctly if padded or just by string
      // Better: extract number
      const numA = parseInt(a.substring(1));
      const numB = parseInt(b.substring(1));
      return numA - numB;
    });

  console.log(`Found ${versionDirs.length} versions.`);

  // 2. State Check
  const appliedMigrationIds = await getAppliedMigrations(databases, config);
  const appliedSet = new Set(appliedMigrationIds);

  for (const version of versionDirs) {
    const versionPath = path.join(migrationsDir, version);
    const indexFile = path.join(versionPath, 'index.ts');
    // Support .js as well
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

    // Load migration file using jiti
    let migrationModule;
    try {
      migrationModule = await jiti.import(validIndexFile);
    } catch (e) {
      console.error(`Failed to load migration file ${validIndexFile}:`, e);
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

    // 3. Backup Hook
    if (migration.requiresBackup && config.backupCommand) {
      console.log('Running backup command...');
      try {
        await execAsync(config.backupCommand);
      } catch (error) {
        console.error('Backup failed:', error);
        process.exit(1);
      }
    } else if (migration.requiresBackup && !config.backupCommand) {
      console.warn(
        'Migration requires backup checking but BACKUP_COMMAND is not set. Proceeding with caution...',
      );
      // Decide if we should exit or prompt. For now, warn.
    }

    // 4. Schema Sync
    const appwriteJsonPath = path.join(versionPath, 'appwrite.json');
    if (fs.existsSync(appwriteJsonPath)) {
      console.log(`Deploying schema for ${version}...`);
      try {
        const relPath = path.relative(process.cwd(), appwriteJsonPath);
        await execAsync(`appwrite deploy collection --all --yes --config "${relPath}"`);
      } catch (error) {
        console.error('Schema sync failed:', error);
        console.error("Make sure you have 'appwrite-cli' installed and authenticated.");
        process.exit(1);
      }
    } else {
      console.warn(`No appwrite.json found in ${version}. Skipping schema sync.`);
    }

    // 5. Polling de Atributos
    if (fs.existsSync(appwriteJsonPath)) {
      await waitForAttributes(databases, config, appwriteJsonPath);
    }

    // 6. Data Execution
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

    // 7. Finalization
    console.log('Finalizing...');
    await recordMigration(databases, config, migration.id, version);

    // update root appwrite.json
    if (fs.existsSync(appwriteJsonPath)) {
      const rootAppwriteJsonPath = path.join(process.cwd(), 'appwrite.json');
      fs.copyFileSync(appwriteJsonPath, 'appwrite.json');
    }

    console.log(`Version ${version} applied successfully.`);
  }

  console.log('All migrations applied.');
};

async function waitForAttributes(
  databases: Databases,
  config: AppConfig,
  appwriteJsonPath: string,
) {
  console.log('Polling attribute status...');

  let schema: any;
  try {
    schema = JSON.parse(fs.readFileSync(appwriteJsonPath, 'utf8'));
  } catch (e) {
    console.error('Failed to parse appwrite.json for polling');
    return;
  }

  const collections = schema.collections || [];

  for (const col of collections) {
    const collectionId = col.$id;
    // We need to check attributes for this collection.
    // The Appwrite API allows listing attributes.
    // We should wait until all are 'available'.

    // This can be complex if there are many.
    // We'll perform a simple check.
    console.log(`Checking attributes for collection ${col.name} (${collectionId})...`);

    let allAvailable = false;
    while (!allAvailable) {
      // Use config.database (system_migrations DB) ? NO.
      // The schema sync applies to the TARGET database.
      // Which DB is that?
      // "appwrite deploy collection" deploys to the project's default database usually?
      // Or does it respect database ID in appwrite.json?
      // appwrite.json structure usually has:
      // "collections": [ { "$id": "...", "$databaseId": "...", ... } ]
      // If $databaseId is present, it deploys there.
      // If NOT, it might deploy to default?
      // The old code used config.databaseId (which was 'default').
      // Now config.database is 'system'.
      // BUT waitForAttributes is checking user collections, NOT migration collection.
      // So we should NOT use config.database here if config.database is now 'system'.
      // We need to check the database ID defined in the collection schema or default to 'default'.

      const targetDbId = col.databaseId || 'default'; // appwrite.json collections usually have databaseId

      try {
        const response = await databases.listAttributes(targetDbId, collectionId);
        const attributes = response.attributes;

        const pending = attributes.filter((attr: any) => attr.status !== 'available');

        if (pending.length === 0) {
          allAvailable = true;
        } else {
          console.log(`Waiting for ${pending.length} attributes to be available...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (e: any) {
        console.warn(
          `Failed to list attributes for ${collectionId} in DB ${targetDbId}: ${e.message}. Retrying...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
