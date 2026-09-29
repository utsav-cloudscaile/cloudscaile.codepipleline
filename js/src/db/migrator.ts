/**
 * Forward-only, versioned MongoDB migrations — the same model migrate-mongo /
 * Rails use, kept in-repo so migrations are TypeScript (typechecked, can
 * import the mongoose models) instead of loose JS files.
 *
 * How it works:
 *
 * - Migrations live in `src/db/migrations/`, one file each, listed **in
 *   order** in the explicit registry (`src/db/migrations/index.ts`). An
 *   explicit import list — not fs-scanning — so the set is identical under
 *   tsx, vitest, and the compiled `dist/` output, and a forgotten
 *   registration is a review-visible diff.
 * - Applied migrations are recorded in the `schema_migrations` collection
 *   (`_id` = migration id, plus description/appliedAt/durationMs). A
 *   migration is applied at most once, ever; already-applied ids are skipped.
 * - **Forward-only.** There are no `down` scripts on purpose: document-DB
 *   rollbacks are usually lossy fictions. To undo something, ship a new
 *   migration that rolls forward. Never edit or delete an applied migration —
 *   add a new one.
 * - A single lock document (`schema_migrations_lock`) serializes runners, so
 *   N app instances starting at once — or a deploy job racing an instance —
 *   apply each migration exactly once. A crashed runner's lock is stolen
 *   after `LOCK_STALE_MS`.
 * - `runMigrations` is called on startup (src/index.ts) unless
 *   `MONGODB_AUTO_MIGRATE=false`, and by the `pnpm migrate` CLI
 *   (src/db/migrate.ts) for pipelines that migrate as a deploy step instead.
 *
 * `validateRegistry` / `planPending` are pure and unit-tested
 * (tests/db/migrator.test.ts); everything else needs a live connection.
 */
import mongoose from 'mongoose';
import { isMongoConnected } from './connection.js';
import { migrations as registeredMigrations } from './migrations/index.js';

export interface MigrationLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface MigrationContext {
  /** Native driver handle — collection-level ops without going through models. */
  db: mongoose.mongo.Db;
  log: MigrationLogger;
}

export interface Migration {
  /** `NNNN-kebab-description` — the zero-padded prefix defines run order. */
  id: string;
  description: string;
  up(context: MigrationContext): Promise<void>;
}

export const MIGRATIONS_COLLECTION = 'schema_migrations';
export const MIGRATION_LOCK_COLLECTION = 'schema_migrations_lock';

const MIGRATION_ID_PATTERN = /^\d{4}-[a-z0-9][a-z0-9-]*$/;
const LOCK_ID = 'schema_migrations';
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 2_000;

interface AppliedRecord {
  _id: string;
  description: string;
  appliedAt: Date;
  durationMs: number;
}

interface LockDoc {
  _id: string;
  token: string;
  lockedAt: Date;
}

const NOOP_LOG: MigrationLogger = { info: () => {}, warn: () => {} };

/**
 * Rejects a malformed registry before anything touches the database:
 * bad id format, duplicate ids/prefixes, or entries out of prefix order
 * (ordering is the whole contract — a shuffled registry would apply
 * migrations in a different order on a fresh database than it did in
 * production).
 */
export function validateRegistry(migrations: readonly Migration[]): void {
  let previousPrefix = 0;
  let previousId = '';
  for (const migration of migrations) {
    if (!MIGRATION_ID_PATTERN.test(migration.id)) {
      throw new Error(
        `Invalid migration id "${migration.id}" — expected NNNN-kebab-description (e.g. 0002-backfill-titles)`,
      );
    }
    const prefix = Number(migration.id.slice(0, 4));
    if (prefix <= previousPrefix) {
      throw new Error(
        `Migration registry out of order: "${migration.id}" must come after "${previousId}" ` +
          'with a strictly greater numeric prefix (renumber on merge conflicts)',
      );
    }
    previousPrefix = prefix;
    previousId = migration.id;
  }
}

/** Registry-ordered migrations not yet recorded as applied. */
export function planPending(
  appliedIds: ReadonlySet<string>,
  migrations: readonly Migration[],
): Migration[] {
  return migrations.filter((migration) => !appliedIds.has(migration.id));
}

function requireDb(): mongoose.mongo.Db {
  const db = mongoose.connection.db;
  if (!isMongoConnected() || db === undefined) {
    throw new Error('runMigrations requires an established MongoDB connection (connectMongo)');
  }
  return db;
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof mongoose.mongo.MongoServerError && error.code === 11000;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Takes the migration lock, waiting out a live holder and stealing from a
 * dead one (lockedAt older than LOCK_STALE_MS). Returns a token that scopes
 * the release, so a stolen-then-reacquired lock can't be deleted by the
 * original (crashed) holder's cleanup.
 */
async function acquireLock(db: mongoose.mongo.Db, log: MigrationLogger): Promise<string> {
  const locks = db.collection<LockDoc>(MIGRATION_LOCK_COLLECTION);
  const token = new mongoose.Types.ObjectId().toHexString();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await locks.insertOne({ _id: LOCK_ID, token, lockedAt: new Date() });
      return token;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const holder = await locks.findOne({ _id: LOCK_ID });
      if (holder !== null && Date.now() - holder.lockedAt.getTime() > LOCK_STALE_MS) {
        log.warn({ lockedAt: holder.lockedAt }, 'stealing stale migration lock');
        // Token-scoped delete: only removes the specific stale holder.
        await locks.deleteOne({ _id: LOCK_ID, token: holder.token });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${LOCK_WAIT_MS}ms waiting for the migration lock — another ` +
            'instance is still migrating, or a crashed run left a lock younger than ' +
            `${LOCK_STALE_MS}ms (inspect the ${MIGRATION_LOCK_COLLECTION} collection)`,
        );
      }
      log.info({}, 'another instance holds the migration lock — waiting');
      await sleep(LOCK_POLL_MS);
    }
  }
}

async function releaseLock(db: mongoose.mongo.Db, token: string): Promise<void> {
  await db.collection<LockDoc>(MIGRATION_LOCK_COLLECTION).deleteOne({ _id: LOCK_ID, token });
}

export interface MigrationStatusEntry {
  id: string;
  description: string;
  appliedAt?: Date;
}

/** Registry entries with their applied timestamps (undefined = pending). */
export async function migrationStatus(): Promise<MigrationStatusEntry[]> {
  const db = requireDb();
  validateRegistry(registeredMigrations);
  const applied = await db.collection<AppliedRecord>(MIGRATIONS_COLLECTION).find().toArray();
  const appliedById = new Map(applied.map((record) => [record._id, record.appliedAt]));
  return registeredMigrations.map((migration) => {
    const appliedAt = appliedById.get(migration.id);
    return {
      id: migration.id,
      description: migration.description,
      ...(appliedAt !== undefined && { appliedAt }),
    };
  });
}

/**
 * Applies every pending migration in registry order under the lock.
 * Throws on the first failure — the failed migration is NOT recorded, so a
 * fixed build re-runs it; write migrations idempotently so a partial
 * failure can be safely retried (see .claude/skills/add-db-migration).
 */
export async function runMigrations(
  options: { log?: MigrationLogger } = {},
): Promise<{ applied: string[] }> {
  const log = options.log ?? NOOP_LOG;
  const db = requireDb();
  validateRegistry(registeredMigrations);

  const token = await acquireLock(db, log);
  try {
    const changelog = db.collection<AppliedRecord>(MIGRATIONS_COLLECTION);
    const appliedRecords = await changelog.find().toArray();
    const appliedIds = new Set(appliedRecords.map((record) => record._id));

    // Applied ids the registry no longer knows: someone edited history.
    // Warn, don't fail — the database is ahead of (not behind) this build.
    const knownIds = new Set(registeredMigrations.map((migration) => migration.id));
    for (const id of appliedIds) {
      if (!knownIds.has(id)) {
        log.warn(
          { id },
          'applied migration is missing from the registry (never delete applied migrations)',
        );
      }
    }

    const pending = planPending(appliedIds, registeredMigrations);
    if (pending.length === 0) {
      log.info({ total: registeredMigrations.length }, 'migrations up to date');
      return { applied: [] };
    }

    const applied: string[] = [];
    for (const migration of pending) {
      log.info({ id: migration.id }, 'applying migration');
      const startedAt = Date.now();
      await migration.up({ db, log });
      const durationMs = Date.now() - startedAt;
      await changelog.insertOne({
        _id: migration.id,
        description: migration.description,
        appliedAt: new Date(),
        durationMs,
      });
      applied.push(migration.id);
      log.info({ id: migration.id, durationMs }, 'migration applied');
    }
    return { applied };
  } finally {
    await releaseLock(db, token);
  }
}
