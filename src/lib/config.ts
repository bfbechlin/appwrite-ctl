import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

export interface AppConfig {
  endpoint: string;
  projectId: string;
  apiKey: string;
  migrationCollectionId: string;
  database: string;
}

/**
 * Load configuration from environment variables or .env file.
 */
export const loadConfig = (envPath: string = '.env'): AppConfig => {
  // Load environment variables.
  dotenv.config({ path: path.resolve(process.cwd(), envPath), override: true });

  // Trim values to avoid copy-paste whitespace bugs in .env files.
  const endpoint = process.env.APPWRITE_ENDPOINT?.trim();
  const projectId = process.env.APPWRITE_PROJECT_ID?.trim();
  const apiKey = process.env.APPWRITE_API_KEY?.trim();

  if (!endpoint || !projectId || !apiKey) {
    throw new Error(
      'Missing required environment variables: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY',
    );
  }

  // Validate endpoint is a well-formed http(s) URL to prevent SSRF via misconfiguration.
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('APPWRITE_ENDPOINT must use http or https protocol.');
    }
  } catch {
    throw new Error(`APPWRITE_ENDPOINT is not a valid URL: "${endpoint}"`);
  }

  // Find root directory.
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'appwrite', 'appwrite-ctl.config.json');

  let migrationCollectionId = 'migrations';
  let database = 'system';

  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (fileConfig.collection) {
        migrationCollectionId = fileConfig.collection;
      }
      if (fileConfig.database) {
        database = fileConfig.database;
      } else if (fileConfig.databaseId) {
        // Backward compatibility.
        database = fileConfig.databaseId;
      }
    } catch {
      console.warn('Could not parse appwrite-ctl.config.json, using defaults.');
    }
  }

  return {
    endpoint,
    projectId,
    apiKey,
    migrationCollectionId,
    database,
  };
};
