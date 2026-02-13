import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
// import { fileURLToPath } from "url";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

export interface AppConfig {
  endpoint: string;
  projectId: string;
  apiKey: string;
  migrationCollectionId: string;
  databaseId: string;
  backupCommand?: string;
}

export const loadConfig = (envPath: string = '.env'): AppConfig => {
  // Load environment variables from specific file
  dotenv.config({ path: path.resolve(process.cwd(), envPath) });

  const endpoint = process.env.APPWRITE_ENDPOINT;
  const projectId = process.env.APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;
  const backupCommand = process.env.BACKUP_COMMAND;

  if (!endpoint || !projectId || !apiKey) {
    throw new Error(
      'Missing required environment variables: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY',
    );
  }

  // Find root directory (where package.json/appwrite folder is)
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'appwrite', 'migration', 'config.json');

  let migrationCollectionId = 'system_migrations';
  let databaseId = 'default';

  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (fileConfig.collection) {
        migrationCollectionId = fileConfig.collection;
      }
      if (fileConfig.databaseId) {
        databaseId = fileConfig.databaseId;
      }
    } catch (error) {
      console.warn('Could not parse config.json, using defaults.');
    }
  }

  return {
    endpoint,
    projectId,
    apiKey,
    migrationCollectionId,
    databaseId,
    backupCommand,
  };
};
