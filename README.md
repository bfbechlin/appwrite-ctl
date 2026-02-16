# Appwrite Ctl

A Node.js (ESM) package to manage Appwrite infrastructure via Version Snapshots. This tool uses a "desired state" approach, where each version is a folder containing a complete snapshot of the schema (`appwrite.json`) and data migration logic.

## Features

- **Version Control for Appwrite Schema**: Manage your `appwrite.json` snapshots alongside your code.
- **Data Migrations**: Execute TypeScript or JavaScript migration scripts (`up` and `down`).
- **State Management**: Tracks applied migrations in a dedicated Appwrite collection (`system_migrations`).
- **Automated Schema Sync**: Automatically applies `appwrite.json` snapshots using the Appwrite CLI.
- **Backup Hooks**: Supports executing external backup commands before migration.
- **Attribute Polling**: Ensures schema attributes are `available` before running data scripts.

## Installation

```bash
npm install -g appwrite-ctl
# or
npm install --save-dev appwrite-ctl
```

### From Repository

To install directly from the GitHub repository:

```bash
npm install github:bfbechlin/appwrite-ctl
# or for a specific branch
npm install github:bfbechlin/appwrite-ctl#main
```

## CLI Usage

You can specify a custom environment file using the `-e` or `--env` flag.

```bash
# Default (uses .env)
npx appwrite-ctl migrations run

# Custom environment file
npx appwrite-ctl migrations run --env .env.prod
```

## Prerequisites

- **Node.js**: v18 or higher.
- **Appwrite CLI**: Installed and authenticated (`appwrite login`).
- **Environment Variables**: The following variables must be set in your `.env` file:

```env
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your_project_id
APPWRITE_API_KEY=your_api_key
BACKUP_COMMAND="docker exec appwrite-mariadb mysqldump ..." # Optional
```

## CI/CD & Automated Deployment (No Login Required)

This tool is designed to work in CI/CD environments without interactive login.

1.  **Install Appwrite CLI**: Ensure `appwrite-cli` is installed in your environment (`npm install -g appwrite-cli`).
2.  **Set Environment Variables**: Configure `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, and `APPWRITE_API_KEY`.
3.  **Automatic Configuration**: When `appwrite-ctl migrations run` is executed, it detects these variables and automatically configures the local Appwrite CLI instance using `appwrite client --key`.

**Required API Key Scopes:**

- `collections.read`, `collections.write`
- `documents.read`, `documents.write`
- `attributes.read`, `attributes.write`
- `indexes.read`, `indexes.write`

## Quick Start

### 1. Initialize the Project

Run the init command to create the necessary folder structure:

```bash
npx appwrite-ctl init
```

This creates:

- `appwrite/migration/` directory.
- `appwrite/migration/config.json` configuration file.

### 2. Setup System Collection

Create the internal collection used to track migration status:

```bash
npx appwrite-ctl migrations setup
```

### 3. Create a Migration

To create a new migration version:

```bash
npx appwrite-ctl migrations create "initial_schema"
```

This command:

1.  Creates a new folder `appwrite/migration/v1/` (auto-increments version).
2.  Generates an `index.ts` file with a boilerplate migration script.
3.  Copies the current `appwrite.json` from your project root (snapshot) into the version folder.

**Folder Structure:**

```
/appwrite
  /migration
    config.json
    /v1
      index.ts        <-- Migration logic
      appwrite.json   <-- Schema snapshot for this version
    /v2
      index.ts
      appwrite.json
```

### 4. Edit Migration Logic

Edit `appwrite/migration/vX/index.ts` to define your data changes:

```typescript
import { Migration } from 'appwrite-ctl';

const migration: Migration = {
  id: 'uuid-generated-id',
  description: 'Update finance schema',
  requiresBackup: true,

  up: async ({ client, databases, log }) => {
    log('Seeding initial data...');
    await databases.createDocument('db', 'users', 'unique()', {
      name: 'Admin',
      role: 'admin',
    });
  },

  down: async ({ client, databases, log }) => {
    // Logic to revert changes
  },
};

export default migration;
```

### 5. Run Migrations

Execute all pending migrations:

```bash
npx appwrite-ctl migrations run
```

The runner performs the following steps for each pending version:

1.  **Backup**: Runs `BACKUP_COMMAND` if `requiresBackup` is true.
2.  **Schema Sync**: Deploys the version's `appwrite.json` using `appwrite deploy`.
3.  **Polling**: Waits for all schema attributes to become `available`.
4.  **Execution**: Runs the `up` function defined in `index.ts`.
5.  **Finalization**: Updates the root `appwrite.json` and records the migration in the database.

### 6. Check Status

View the history of applied migrations:

```bash
npx appwrite-ctl migrations status
```

## Configuration (`appwrite/migration/config.json`)

```json
{
  "collection": "migrations",
  "database": "system"
}
```

## CLI Commands

| Command                    | Description                                                           |
| :------------------------- | :-------------------------------------------------------------------- |
| `init`                     | Initialize the project folder structure and config.                   |
| `migrations setup`         | Create the `system` database and `migrations` collection in Appwrite. |
| `migrations create <name>` | Create a new migration version folder with snapshot.                  |
| `migrations run`           | Execute all pending migrations in order.                              |
| `migrations status`        | List applied and pending migrations.                                  |

## License

ISC
