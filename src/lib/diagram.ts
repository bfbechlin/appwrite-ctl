import fs from 'fs';
import path from 'path';
import { loadSecurityLedger, getExceptions } from './security.js';
import type { SecurityLedger, SecurityException } from '../types/index.js';

interface Column {
  key: string;
  type: string;
  required?: boolean;
  array?: boolean;
  size?: number;
  default?: unknown;
  min?: number;
  max?: number;
  format?: string;
  elements?: string[];
  encrypt?: boolean;
  relatedTable?: string;
  relationType?: string;
  twoWay?: boolean;
  twoWayKey?: string;
  onDelete?: string;
  side?: string;
}

interface Index {
  key: string;
  type: string;
  status?: string;
  columns: string[];
  orders: string[];
}

interface Table {
  $id: string;
  $permissions: string[];
  databaseId: string;
  name: string;
  enabled: boolean;
  rowSecurity: boolean;
  columns: Column[];
  indexes: Index[];
}

interface Database {
  $id: string;
  name: string;
  enabled: boolean;
}

interface Bucket {
  $id: string;
  $permissions: string[];
  fileSecurity: boolean;
  name: string;
  enabled: boolean;
  maximumFileSize: number;
  allowedFileExtensions: string[];
  compression: string;
  encryption: boolean;
  antivirus: boolean;
}

interface Snapshot {
  projectId: string;
  tablesDB: Database[];
  tables: Table[];
  buckets: Bucket[];
  teams: { $id: string; name: string }[];
  topics: { $id: string; name: string }[];
}

const MERMAID_CARDINALITY: Record<string, string> = {
  oneToOne: '||--||',
  oneToMany: '||--o{',
  manyToOne: '}o--||',
  manyToMany: '}o--o{',
};

/**
 * Sanitize a string for safe embedding inside Mermaid erDiagram entity/field names.
 * Braces, backticks, double-quotes, and newlines can break Mermaid's parser.
 */
const sanitizeMermaid = (value: string): string =>
  value
    .replace(/[\r\n]+/g, ' ') // no literal newlines
    .replace(/[{}]/g, '') // brace characters end entity blocks
    .replace(/"/g, "'") // double-quote ends Mermaid label strings
    .replace(/`/g, "'"); // backtick is a Mermaid reserved delimiter

/**
 * Map Appwrite column types to concise display types for the ER diagram.
 */
const mapColumnType = (col: Column): string => {
  if (col.type === 'string' && col.format === 'enum') return 'enum';
  if (col.type === 'relationship') return 'relationship';
  // Sanitize types that conflict with Mermaid reserved words
  const safeTypes: Record<string, string> = {
    text: 'longtext',
    point: 'geopoint',
    polygon: 'geopolygon',
  };
  return safeTypes[col.type] ?? col.type;
};

/**
 * Format a human-readable file size string.
 */
const formatFileSize = (bytes: number): string => {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
};

/**
 * Build the Mermaid erDiagram block for a set of tables.
 */
const buildErDiagram = (tables: Table[]): string => {
  const lines: string[] = ['```mermaid', 'erDiagram'];
  const relationships: string[] = [];
  const renderedPairs = new Set<string>();

  for (const table of tables) {
    const entityName = sanitizeMermaid(table.name);
    lines.push(`    ${entityName} {`);

    // Always add implicit id primary key
    lines.push(`        string id PK`);

    for (const col of table.columns) {
      if (col.type === 'relationship') {
        // Only emit from the parent side, and skip if pair already rendered
        if (col.side === 'parent' && col.relatedTable) {
          const relatedName = sanitizeMermaid(col.relatedTable);
          const pairKey = [entityName, relatedName].sort().join(':');
          if (!renderedPairs.has(pairKey)) {
            renderedPairs.add(pairKey);
            const cardinality = MERMAID_CARDINALITY[col.relationType ?? 'oneToMany'] ?? '||--||';
            const label = `"${sanitizeMermaid(col.key)}"`;
            relationships.push(`    ${entityName} ${cardinality} ${relatedName} : ${label}`);
          }
        }
        continue;
      }

      const type = mapColumnType(col);
      const colKey = sanitizeMermaid(col.key);
      const comment = col.required ? '"NOT NULL"' : '';
      lines.push(`        ${type} ${colKey} ${comment}`.trimEnd());
    }

    lines.push(`    }`);
  }

  if (relationships.length > 0) {
    lines.push('');
    lines.push(...relationships);
  }

  lines.push('```');
  return lines.join('\n');
};

/**
 * Render security exception callout lines into a `> [!WARNING]` block.
 */
const buildSecurityCallout = (exceptions: SecurityException[]): string => {
  if (exceptions.length === 0) return '';
  const lines: string[] = [''];
  lines.push('> [!WARNING]');
  for (const ex of exceptions) {
    lines.push(
      `> **Security Exception Acknowledged:** (\`${ex.rule}\`) — *${ex.justification}* — (Author: ${ex.author}, ${ex.date})`,
    );
  }
  return lines.join('\n');
};

/**
 * Build markdown documentation for a single collection.
 */
const buildCollectionDoc = (table: Table, exceptions: SecurityException[] = []): string => {
  const sections: string[] = [];
  const status = table.enabled ? '🟢 Enabled' : '🔴 Disabled';
  sections.push(`#### ${table.name} (\`${table.$id}\`)`);
  sections.push('');
  sections.push(`- **Status:** ${status}`);
  sections.push(`- **Row-level Security:** ${table.rowSecurity ? 'Yes' : 'No'}`);

  // Permissions
  if (table.$permissions.length > 0) {
    sections.push('');
    sections.push('**Permissions:**');
    sections.push('');
    sections.push('| Permission |');
    sections.push('| --- |');
    for (const perm of table.$permissions) {
      sections.push(`| \`${perm}\` |`);
    }
  }

  // Columns (non-relationship)
  const dataCols = table.columns.filter((c) => c.type !== 'relationship');
  if (dataCols.length > 0) {
    sections.push('');
    sections.push('**Columns:**');
    sections.push('');
    sections.push('| Key | Type | Required | Default | Details |');
    sections.push('| --- | --- | --- | --- | --- |');

    for (const col of dataCols) {
      const type = mapColumnType(col);
      const required = col.required ? '✅' : '—';
      const def = col.default !== null && col.default !== undefined ? `\`${col.default}\`` : '—';

      const details: string[] = [];
      if (col.size) details.push(`size: ${col.size}`);
      if (col.min !== undefined && col.min !== null) details.push(`min: ${col.min}`);
      if (col.max !== undefined && col.max !== null) details.push(`max: ${col.max}`);
      if (col.format === 'enum' && col.elements) {
        details.push(`values: ${col.elements.map((e) => `\`${e}\``).join(', ')}`);
      }
      if (col.array) details.push('array');
      if (col.encrypt) details.push('encrypted');

      sections.push(
        `| \`${col.key}\` | ${type} | ${required} | ${def} | ${details.join('; ') || '—'} |`,
      );
    }
  }

  // Relationships
  const relCols = table.columns.filter((c) => c.type === 'relationship');
  if (relCols.length > 0) {
    sections.push('');
    sections.push('**Relationships:**');
    sections.push('');
    sections.push('| Key | Related Collection | Type | Side | On Delete | Two-way |');
    sections.push('| --- | --- | --- | --- | --- | --- |');

    for (const col of relCols) {
      sections.push(
        `| \`${col.key}\` | ${col.relatedTable} | ${col.relationType} | ${col.side} | ${col.onDelete ?? '—'} | ${col.twoWay ? 'Yes' : 'No'} |`,
      );
    }
  }

  // Indexes
  if (table.indexes.length > 0) {
    sections.push('');
    sections.push('**Indexes:**');
    sections.push('');
    sections.push('| Key | Type | Columns | Orders |');
    sections.push('| --- | --- | --- | --- |');

    for (const idx of table.indexes) {
      sections.push(
        `| \`${idx.key}\` | ${idx.type} | ${idx.columns.join(', ')} | ${idx.orders.join(', ')} |`,
      );
    }
  }

  const callout = buildSecurityCallout(exceptions);
  if (callout) sections.push(callout);

  return sections.join('\n');
};

/**
 * Build the buckets documentation section.
 */
const buildBucketsDoc = (buckets: Bucket[], ledger?: SecurityLedger): string => {
  if (buckets.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Buckets');

  for (const b of buckets) {
    const extensions =
      b.allowedFileExtensions.length > 0 ? b.allowedFileExtensions.join(', ') : 'any';
    const status = b.enabled ? '🟢 Enabled' : '🔴 Disabled';

    lines.push('');
    lines.push(`### ${b.name} (\`${b.$id}\`)`);
    lines.push('');
    lines.push(`- **Status:** ${status}`);
    lines.push('');
    lines.push('| Max Size | Extensions | Compression | Encryption | Antivirus | File Security |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    lines.push(
      `| ${formatFileSize(b.maximumFileSize)} | ${extensions} | ${b.compression} | ${b.encryption ? '✅' : '—'} | ${b.antivirus ? '✅' : '—'} | ${b.fileSecurity ? 'Yes' : 'No'} |`,
    );

    if (b.$permissions.length > 0) {
      lines.push('');
      lines.push('**Permissions:**');
      lines.push('');
      lines.push('| Permission |');
      lines.push('| --- |');
      for (const perm of b.$permissions) {
        lines.push(`| \`${perm}\` |`);
      }
    }

    const bucketExceptions = ledger ? getExceptions(ledger, 'buckets', b.$id) : [];
    const callout = buildSecurityCallout(bucketExceptions);
    if (callout) lines.push(callout);
  }

  return lines.join('\n');
};

/**
 * Generate the full schema documentation markdown from a snapshot.
 */
export const generateSchemaDoc = (snapshotPath: string, version: string): string => {
  const raw = fs.readFileSync(snapshotPath, 'utf-8');
  const snapshot: Snapshot = JSON.parse(raw);

  // Load security ledger from appwrite/ at the project root
  const appwriteDir = path.join(process.cwd(), 'appwrite');
  const ledger = loadSecurityLedger(appwriteDir);

  // Load appwrite-ctl config to discover the system database name
  const configPath = path.join(process.cwd(), 'appwrite', 'appwrite-ctl.config.json');
  let systemDbName = 'system';
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (cfg.database) systemDbName = cfg.database;
    } catch {
      // Ignore parse errors, keep default
    }
  }

  const sections: string[] = [];
  sections.push(`# Schema — ${version}`);
  sections.push('');
  sections.push(`> Auto-generated from \`appwrite.config.json\` (${version})`);

  // Filter out system database
  const userDatabases = snapshot.tablesDB.filter((db) => db.$id !== systemDbName);

  for (const db of userDatabases) {
    const dbTables = snapshot.tables.filter((t) => t.databaseId === db.$id);
    if (dbTables.length === 0) continue;

    const dbStatus = db.enabled ? '🟢 Enabled' : '🔴 Disabled';
    sections.push('');
    sections.push(`## Database: ${db.name} (\`${db.$id}\`)`);
    sections.push('');
    sections.push(`- **Status:** ${dbStatus}`);
    sections.push(`- **Collections:** ${dbTables.length}`);

    // ER Diagram for this database
    sections.push('');
    sections.push('### ER Diagram');
    sections.push('');
    sections.push(buildErDiagram(dbTables));

    // Collection details
    sections.push('');
    sections.push('### Collections');

    for (const table of dbTables) {
      sections.push('');
      const collectionExceptions = getExceptions(ledger, 'collections', table.$id);
      sections.push(buildCollectionDoc(table, collectionExceptions));
    }
  }

  // Buckets section
  if (snapshot.buckets.length > 0) {
    sections.push('');
    sections.push(buildBucketsDoc(snapshot.buckets, ledger));
  }

  return sections.join('\n') + '\n';
};
