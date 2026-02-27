import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import type {
  SecurityException,
  SecurityExceptions,
  SecurityLedger,
  SecurityRules,
} from '../types/index.js';

export type { SecurityException, SecurityExceptions, SecurityLedger, SecurityRules };

const CTL_CONFIG_FILENAME = 'appwrite-ctl.config.json';

/**
 * Default security rules included in every freshly initialised appwrite-ctl.config.json.
 * Mirrors the validation intent of the future `appwrite-ctl audit` command.
 */
export const DEFAULT_RULES: SecurityRules = {
  'require-row-security': { enabled: true, severity: 'error' },
  'forbid-role-all-write': { enabled: true, severity: 'error' },
  'forbid-role-all-delete': { enabled: true, severity: 'error' },
  'forbid-role-all-read': { enabled: true, severity: 'warn' },
  'forbid-role-all-create': { enabled: true, severity: 'warn' },
  'require-file-security': { enabled: true, severity: 'warn' },
};

/**
 * Assert that a resolved file path stays within the expected parent directory.
 * Throws if the path escapes via `..` components.
 */
const assertSafePath = (resolvedPath: string, expectedParent: string): void => {
  const normalizedParent = path.resolve(expectedParent);
  const normalizedTarget = path.resolve(resolvedPath);
  if (
    !normalizedTarget.startsWith(normalizedParent + path.sep) &&
    normalizedTarget !== normalizedParent
  ) {
    throw new Error(`Path traversal detected: '${resolvedPath}' is outside '${expectedParent}'.`);
  }
};

/**
 * Read the raw appwrite-ctl.config.json object from disk.
 * Returns an empty object if the file does not exist or cannot be parsed.
 */
const readCtlConfig = (appwriteDir: string): Record<string, unknown> => {
  const filePath = path.join(appwriteDir, CTL_CONFIG_FILENAME);
  assertSafePath(filePath, process.cwd());
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Write the raw appwrite-ctl.config.json object back to disk.
 */
const writeCtlConfig = (appwriteDir: string, data: Record<string, unknown>): void => {
  const filePath = path.join(appwriteDir, CTL_CONFIG_FILENAME);
  assertSafePath(filePath, process.cwd());
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
};

/**
 * Load the security ledger from the `security` key inside appwrite-ctl.config.json.
 * Returns an empty ledger if the key or file does not exist.
 */
export const loadSecurityLedger = (appwriteDir: string): SecurityLedger => {
  const cfg = readCtlConfig(appwriteDir);
  const raw = cfg.security as SecurityLedger | undefined;
  if (!raw || typeof raw !== 'object') {
    return { exceptions: {} };
  }
  return { rules: raw.rules, exceptions: raw.exceptions ?? {} };
};

/**
 * Persist the security ledger back into the `security` key of appwrite-ctl.config.json,
 * preserving all other top-level keys.
 */
export const saveSecurityLedger = (appwriteDir: string, ledger: SecurityLedger): void => {
  const cfg = readCtlConfig(appwriteDir);
  cfg.security = ledger;
  writeCtlConfig(appwriteDir, cfg);
};

/**
 * Return the exceptions list for a specific resource type + ID.
 * Returns an empty array if no entry exists.
 */
export const getExceptions = (
  ledger: SecurityLedger,
  type: 'collections' | 'buckets',
  id: string,
): SecurityException[] => {
  return ledger.exceptions[type]?.[id] ?? [];
};

/**
 * Resolve the current author using `git config user.name` falling back to the OS username.
 */
export const resolveAuthor = (): string => {
  try {
    const name = execSync('git config user.name', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (name) return name;
  } catch {
    // Not in a git repo or git not available
  }
  return os.userInfo().username;
};
