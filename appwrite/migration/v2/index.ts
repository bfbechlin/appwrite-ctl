import { Migration } from 'appwrite-ctl';

const migration: Migration = {
  id: '65270cb7-5bb4-45bc-b522-55cd6cc09e26',
  description: 'test_fix',
  requiresBackup: false,
  up: async ({ client, databases, log, error }) => {
    log('Executing up migration for test_fix');
    // Write your migration logic here
  },
  down: async ({ client, databases, log, error }) => {
    log('Executing down migration for test_fix');
  },
};

export default migration;
