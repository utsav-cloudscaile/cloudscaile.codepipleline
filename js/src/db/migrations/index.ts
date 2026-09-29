/**
 * The migration registry: every migration, in the order it runs. An explicit
 * import list on purpose — identical under tsx, vitest, and `dist/`, and a
 * new migration that isn't registered shows up as a missing diff line in
 * review instead of silently never running.
 *
 * Append only. Never reorder, edit, or delete an entry that has been applied
 * anywhere (validateRegistry enforces ascending `NNNN-` prefixes; renumber
 * yours on merge conflicts). See .claude/skills/add-db-migration.
 */
import type { Migration } from '../migrator.js';
import { baselineIndexes } from './0001-baseline-indexes.js';

export const migrations: readonly Migration[] = [baselineIndexes];
