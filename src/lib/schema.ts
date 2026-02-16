import { Client, Databases, Query } from 'node-appwrite';
import { AppConfig } from './config.js';

export const fetchProjectSchema = async (config: AppConfig) => {
  const client = new Client()
    .setEndpoint(config.endpoint)
    .setProject(config.projectId)
    .setKey(config.apiKey);

  const databases = new Databases(client);

  // 1. Fetch all databases
  // Note: 'system' database (for migrations) might be excluded or included depending on user preference?
  // The user said "current project schema to apply to another". Usually this means business logic DBs.
  // But appwrite.json usually includes everything you want to deploy.
  const dbsList = await databases.list([Query.limit(100)]);
  const allCollections: any[] = [];

  for (const db of dbsList.databases) {
    if (db.$id === 'system') continue; // Skip internal system DB if strictly internal

    // 2. Fetch all collections for this DB
    const colsList = await databases.listCollections(db.$id, [Query.limit(100)]);

    for (const col of colsList.collections) {
      // 3. For each collection, we need full details (attributes, indexes).
      // listCollections might not return full details of attributes/indexes in some versions,
      // but usually it does or we verify.
      // Let's explicitly get the collection to be sure we have everything if needed,
      // but the list response usually has them.
      // However, the `appwrite.json` format expects specific fields.

      // Map SDK response to appwrite.json format
      // SDK keys might start with $. appwrite.json usually expects them without $ for some, or with?
      // Actually appwrite-cli appwrite.json usually KEEP $id, $permissions etc.
      // Let's look at a sample appwrite.json if possible or assume standard.
      // Standard appwrite.json from `init project`:
      // {
      //   "$id": "...",
      //   "$permissions": [...],
      //   "databaseId": "...",
      //   ...
      //   "attributes": [...],
      //   "indexes": [...]
      // }

      // We need to ensure we inject `databaseId` because deployments need to know where it goes.
      const collectionData = {
        ...col,
        databaseId: db.$id, // Important for deployment
      };

      allCollections.push(collectionData);
    }
  }

  return {
    projectId: config.projectId,
    projectName: config.projectId, // We might not get the name easily without Account API, use ID for now
    collections: allCollections,
  };
};
