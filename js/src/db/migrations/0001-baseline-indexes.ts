import type { Migration } from '../migrator.js';
import {
  MessageModel,
  RunModel,
  SessionModel,
  ToolCallModel,
  UsageRecordModel,
} from '../models.js';

/**
 * Baseline: indexes are owned by migrations, not by mongoose side effects.
 * `connectMongo` disables autoIndex, so this migration is the one place
 * index creation happens. `syncIndexes()` also drops indexes that no longer
 * match the schema, which makes re-running it the standard way to pick up
 * index changes — a later migration that alters indexes should edit the
 * schema and call syncIndexes on just the affected model.
 */
export const baselineIndexes: Migration = {
  id: '0001-baseline-indexes',
  description: 'Sync all indexes declared on the mongoose schemas (src/db/models.ts)',
  async up({ log }) {
    for (const model of [SessionModel, RunModel, MessageModel, ToolCallModel, UsageRecordModel]) {
      const dropped = await model.syncIndexes();
      log.info({ collection: model.collection.name, dropped }, 'indexes synced');
    }
  },
};
