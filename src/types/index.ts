// Re-export Appwrite types so users don't need to install the SDK directly just for types if they don't want to
import type { Client, Databases } from 'node-appwrite';
export type { Client, Databases } from 'node-appwrite';

export type Logger = (msg: string) => void;

export interface MigrationContext {
  client: Client;
  databases: Databases;
  log: Logger;
  error: Logger;
}

export type MigrationFunction = (context: MigrationContext) => Promise<void>;

export interface Migration {
  id: string;
  description?: string;
  requiresBackup?: boolean;
  up: MigrationFunction;
  down?: MigrationFunction;
}

export interface Config {
  collection: string; // Connection ID for system_migrations
  database: string; // Database ID where migrations are tracked (defaults to 'system')
}

export interface MigrationFile {
  version: string; // v1, v2, etc.
  path: string;
  content: Migration;
}
