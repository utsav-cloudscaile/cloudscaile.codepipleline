import mongoose from 'mongoose';
import type { AppConfig } from '@/config/index.js';

/**
 * Connects the process-wide mongoose instance. Called once from `main()`
 * (src/index.ts) before the trigger server starts — a short
 * `serverSelectionTimeoutMS` keeps a bad/absent MongoDB from hanging startup
 * for the driver's default 30s and instead fails fast with a readable error,
 * matching how `loadAppConfig`/`loadPolicy` treat missing configuration.
 *
 * Everything downstream (src/db/recorder.ts) checks `isMongoConnected()`
 * instead of assuming a connection, so tests — and any embedding that never
 * calls this — get a no-op persistence layer rather than mongoose silently
 * buffering writes that will never land.
 */
export async function connectMongo(config: AppConfig['mongo']): Promise<void> {
  // Indexes are owned by migrations (0001-baseline-indexes + successors),
  // not created as a side effect of model compilation — autoIndex would race
  // app startup against index builds and hide index changes from review.
  mongoose.set('autoIndex', false);
  await mongoose.connect(config.uri, {
    ...(config.dbName !== undefined && { dbName: config.dbName }),
    serverSelectionTimeoutMS: 5_000,
  });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

/** True once `connectMongo` has an established connection (readyState 1). */
export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
