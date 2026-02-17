# Appwrite Ctl

A Node.js (ESM) package to manage Appwrite infrastructure via Version Snapshots. Uses the **Appwrite CLI** for schema pull/push operations and the **Appwrite SDK** for data migration scripts.

## Features

- **Version Control for Appwrite Schema**: Manage your `appwrite.config.json` snapshots alongside your code.
- **CLI-based Snapshots**: Uses `appwrite-cli` pull/push for reliable schema synchronization.
- **Data Migrations**: Execute TypeScript or JavaScript migration scripts (`up` and `down`) using the Node.js SDK.
- **State Management**: Tracks applied migrations in a dedicated Appwrite collection (`system.migrations`).
- **Backup Hooks**: Supports executing external backup commands before migration.
- **Attribute Polling**: Ensures schema attributes are `available` before running data scripts.

## Installation

```bash
npm install -g appwrite-ctl
# or
npm install --save-dev appwrite-ctl
```

### From Repository

```bash
npm install github:bfbechlin/appwrite-ctl
```

## Prerequisites

- **Node.js**: v18 or higher.
- **Appwrite CLI**: Installed globally (`npm install -g appwrite-cli`). The tool configures the CLI automatically using API key — no interactive login required.
- **Environment Variables**:

```env
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your_project_id
APPWRITE_API_KEY=your_api_key
BACKUP_COMMAND="docker exec appwrite-mariadb mysqldump ..." # Optional
```

## Architecture

The tool uses a clear separation of concerns:

| Operation                    | Tool             | Why                                                                          |
| :--------------------------- | :--------------- | :--------------------------------------------------------------------------- |
| Schema snapshots (pull/push) | **Appwrite CLI** | Has full serialization/deserialization of schemas via `appwrite.config.json` |
| Data migrations (up/down)    | **Appwrite SDK** | Provides programmatic access to databases, documents, etc.                   |
| Migration tracking           | **Appwrite SDK** | Creates/reads documents in the `system.migrations` collection                |

## CLI Usage

```bash
# Default (uses .env)
npx appwrite-ctl migrations run

# Custom environment file
npx appwrite-ctl migrations run --env .env.prod
```

## Quick Start

### 1. Initialize the Project

```bash
npx appwrite-ctl init
```

Creates:

- `appwrite/migration/` directory
- `appwrite/migration/config.json` configuration file

### 2. Setup System Collection

```bash
npx appwrite-ctl migrations setup
```

### 3. Create a Migration

```bash
npx appwrite-ctl migrations create
```

This command:

1. Creates `appwrite/migration/vN/` (auto-increments version).
2. Generates an `index.ts` file with a boilerplate migration script.
3. Copies the current `appwrite.config.json` from the project root (or pulls from Appwrite via CLI if no local snapshot exists).

**Folder Structure:**

```
/appwrite
  /migration
    config.json
    /v1
      index.ts                 <-- Migration logic (SDK)
      appwrite.config.json     <-- Schema snapshot (CLI format)
    /v2
      index.ts
      appwrite.config.json
```

### 4. Edit Migration Logic

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

### 5. Update a Snapshot

After making schema changes in the Appwrite console, update a migration version's snapshot:

```bash
npx appwrite-ctl migrations update v1
```

This pulls the current state from Appwrite via CLI and saves it as the version's `appwrite.config.json`.

### 6. Run Migrations

```bash
npx appwrite-ctl migrations run
```

The runner performs these steps for each pending version:

1. **Configure CLI**: Sets endpoint, project-id, and API key on appwrite-cli.
2. **Backup**: Runs `BACKUP_COMMAND` if `requiresBackup` is true.
3. **Schema Push**: Pushes the version's `appwrite.config.json` via CLI (settings, tables, buckets, teams, topics).
4. **Polling**: Waits for all schema attributes to become `available` (via SDK).
5. **Execution**: Runs the `up` function defined in `index.ts` (via SDK).
6. **Finalization**: Records the migration as applied.

### 7. Check Status

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

## CI/CD & Automated Deployment

1. Install Appwrite CLI: `npm install -g appwrite-cli`
2. Set environment variables: `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`
3. The tool automatically configures the CLI via `appwrite client --key` — no login required.

**Required API Key Scopes:**

- `collections.read`, `collections.write`
- `documents.read`, `documents.write`
- `attributes.read`, `attributes.write`
- `indexes.read`, `indexes.write`

## CLI Commands

| Command                       | Description                                                   |
| :---------------------------- | :------------------------------------------------------------ |
| `init`                        | Initialize the project folder structure and config.           |
| `migrations setup`            | Create the `system` database and `migrations` collection.     |
| `migrations create`           | Create a new migration version with snapshot.                 |
| `migrations update <version>` | Update a version's snapshot by pulling from Appwrite via CLI. |
| `migrations run`              | Execute all pending migrations in order.                      |
| `migrations status`           | List applied and pending migrations.                          |

## License

ISC
