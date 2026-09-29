/**
 * Migration CLI — the deploy-step entry point for environments that set
 * MONGODB_AUTO_MIGRATE=false instead of migrating on app startup:
 *
 *   pnpm migrate           # apply pending migrations (or: node dist/db/migrate.js up)
 *   pnpm migrate:status    # list applied vs pending  (or: node dist/db/migrate.js status)
 *
 * Uses the same loadAppConfig/connectMongo path as the server, so it runs
 * from the same image with the same env. Exit code is non-zero on failure —
 * wire it before the app rollout so a failed migration halts the deploy.
 */
import { loadAppConfig } from '@/config/index.js';
import { createLogger } from '@/logger/index.js';
import { connectMongo, disconnectMongo } from './connection.js';
import { migrationStatus, runMigrations } from './migrator.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  if (command !== 'up' && command !== 'status') {
    throw new Error(`Unknown command "${command}" — expected "up" or "status"`);
  }

  const config = loadAppConfig();
  const logger = createLogger(config.logLevel);
  await connectMongo(config.mongo);
  try {
    if (command === 'status') {
      for (const entry of await migrationStatus()) {
        const state = entry.appliedAt ? `applied ${entry.appliedAt.toISOString()}` : 'PENDING';
        // CLI table output, not app logging — stdout is this command's product.
        // biome-ignore lint/suspicious/noConsole: intentional CLI output
        console.log(`${entry.id}  [${state}]  ${entry.description}`);
      }
      return;
    }
    const { applied } = await runMigrations({ log: logger });
    logger.info({ applied }, applied.length > 0 ? 'migrations applied' : 'nothing to migrate');
  } finally {
    await disconnectMongo();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error: unknown) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  });
}
