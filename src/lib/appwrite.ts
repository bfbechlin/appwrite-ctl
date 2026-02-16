import { Client, Databases, ID, Query } from 'node-appwrite';
import { AppConfig } from './config.js';

export const createAppwriteClient = (config: AppConfig) => {
  const client = new Client()
    .setEndpoint(config.endpoint)
    .setProject(config.projectId)
    .setKey(config.apiKey);

  const databases = new Databases(client);

  return { client, databases };
};

export const ensureMigrationCollection = async (databases: Databases, config: AppConfig) => {
  // Ensure the system database exists
  try {
    await databases.get(config.database);
  } catch (error: any) {
    if (error.code === 404) {
      console.log(`Creating system database '${config.database}'...`);
      await databases.create(config.database, config.database);
    } else {
      throw error;
    }
  }

  // Ensure the migration collection exists within the system database
  try {
    await databases.getCollection(config.database, config.migrationCollectionId);
  } catch (error: any) {
    if (error.code === 404) {
      console.log(`Creating migration collection '${config.migrationCollectionId}'...`);
      await databases.createCollection(
        config.database,
        config.migrationCollectionId,
        config.migrationCollectionId,
      );
      await databases.createStringAttribute(
        config.database,
        config.migrationCollectionId,
        'name',
        255,
        true,
      );
      await databases.createDatetimeAttribute(
        config.database,
        config.migrationCollectionId,
        'appliedAt',
        true,
      );
    } else {
      throw error;
    }
  }
};

export const getAppliedMigrations = async (
  databases: Databases,
  config: AppConfig,
): Promise<string[]> => {
  try {
    const response = await databases.listDocuments(config.database, config.migrationCollectionId, [
      Query.limit(5000),
    ]);
    return response.documents.map((doc) => doc.$id);
  } catch (error: any) {
    if (error.code === 404) {
      // If DB or Collection unavailable, no migrations applied
      return [];
    }
    throw error;
  }
};

export const recordMigration = async (
  databases: Databases,
  config: AppConfig,
  migrationId: string,
  name: string,
) => {
  await databases.createDocument(config.database, config.migrationCollectionId, migrationId, {
    name,
    appliedAt: new Date().toISOString(),
  });
};
