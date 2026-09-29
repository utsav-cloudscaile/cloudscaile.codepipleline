/**
 * Mongoose models for pipeline persistence. Five collections, all keyed by the
 * two identifiers every later read API needs: `sessionId` (the Agent SDK's
 * `session_id`, also what `/trigger` callers pass back to resume) and `userId`
 * (the gateway-verified JWT's `sub`, falling back to `email`).
 *
 * The split follows the shape most chat products use (a conversations
 * collection + an append-only messages collection + a usage ledger):
 *
 * - `sessions`      — one doc per Agent SDK conversation: title, repo, status,
 *                     cumulative usage/cost rollups (cheap "list my
 *                     conversations" and quota checks without aggregation).
 * - `runs`          — one doc per POST /trigger invocation: the request as
 *                     received, the stage results, and `donePayload` — the
 *                     exact final SSE `done`/`error` body, so a later
 *                     "get conversation" API can return the same format the
 *                     trigger API streams today without re-deriving it.
 * - `messages`      — one doc per SDK message, in order (`seq`). `event` +
 *                     `payload` mirror the SSE frames (`event: message.type`,
 *                     redacted message as data) so replaying a conversation is
 *                     a sorted find, byte-compatible with the live stream.
 *                     Extracted fields (text, toolUseIds, usage) exist only to
 *                     make queries cheap — `payload` stays the source of truth.
 * - `tool_calls`    — one doc per tool_use, correlated with its tool_result:
 *                     this is where "what changed" (Edit/Write inputs) and
 *                     "what was committed/pushed" (mcp__git__* calls) are
 *                     directly queryable, without walking message payloads.
 * - `usage_records` — append-only metering ledger, one doc per completed run.
 *                     Usage limits later become an indexed sum over
 *                     `{userId, createdAt}` for the billing window — the same
 *                     ledger-then-aggregate pattern metering systems use —
 *                     without touching the conversation collections.
 * - `repo_instructions` — CRUD-managed, per-repo standing context
 *                     (src/db/repoInstructions.ts): named text blocks
 *                     supplied out of band, keyed by repo only — not
 *                     committed to the target repo (cf. GitHub Copilot's
 *                     `.github/copilot-instructions.md` or Cursor's
 *                     `.cursor/rules/*.mdc`, which this service can't rely on
 *                     for a repo it doesn't control the contents of), and not
 *                     scoped to whichever caller happens to trigger that
 *                     repo — that `/v1/trigger` injects into the stage's
 *                     system prompt, XML-tagged and layered after the master
 *                     context (see src/pipeline/repoInstructions.ts).
 */
import type { InferSchemaType, Model } from 'mongoose';
// Default-import + destructure: mongoose is CJS, and Node's ESM named-export
// detection misses `models`, so `import { models } from 'mongoose'` passes
// typecheck but throws at runtime.
import mongoose from 'mongoose';

const { model, models, Schema } = mongoose;

/**
 * MongoDB's schema-versioning pattern: every document records the schema
 * shape it was written with. Readers must treat an **absent** field as
 * version 1 (documents written before the field existed, or inserted via
 * paths that skip defaults, e.g. bulkWrite upserts). Bump this when a
 * document's shape changes incompatibly, ship a migration that backfills or
 * a reader that handles both versions, and note the change in the migration.
 */
export const CURRENT_SCHEMA_VERSION = 1;

const schemaVersionField = {
  schemaVersion: { type: Number, default: CURRENT_SCHEMA_VERSION },
} as const;

/** Token/cost rollup shared by session totals and usage records. */
const usageTotalsFields = {
  costUsd: { type: Number, default: 0 },
  numTurns: { type: Number, default: 0 },
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  cacheReadInputTokens: { type: Number, default: 0 },
  cacheCreationInputTokens: { type: Number, default: 0 },
} as const;

const sessionSchema = new Schema(
  {
    ...schemaVersionField,
    /** Agent SDK session_id — the resume handle callers already hold. */
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    userEmail: { type: String },
    /**
     * Derived from the first prompt (see deriveTitle, extract.ts). The SDK
     * also accepts a `title` option on query() and can rename via
     * renameSession(); if we start passing that through, keep this in sync.
     */
    title: { type: String },
    repoUrl: { type: String },
    repoSlug: { type: String },
    status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
    // Snapshot of the SDK's system/init message for this session.
    model: { type: String },
    claudeCodeVersion: { type: String },
    permissionMode: { type: String },
    cwd: { type: String },
    tools: { type: [String], default: undefined },
    mcpServers: { type: [{ name: String, status: String, _id: false }], default: undefined },
    runCount: { type: Number, default: 0 },
    /** Cumulative across every run in this session ($inc on each result). */
    totals: { type: new Schema(usageTotalsFields, { _id: false }), default: () => ({}) },
    /** Cumulative per-model usage, keyed by model id (SDK `modelUsage`). */
    modelUsage: { type: Schema.Types.Mixed },
    lastRunAt: { type: Date },
  },
  { timestamps: true },
);
// "List this user's conversations, newest activity first."
sessionSchema.index({ userId: 1, updatedAt: -1 });

const runSchema = new Schema(
  {
    ...schemaVersionField,
    sessionId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    userEmail: { type: String },
    /** The /trigger request body as received (minus auth material). */
    request: {
      type: new Schema(
        {
          prompt: { type: String, required: true },
          repoUrl: { type: String, required: true },
          sessionId: { type: String },
          dir: { type: String },
          refDirs: { type: [{ path: String, _id: false }], default: undefined },
        },
        { _id: false },
      ),
      required: true,
    },
    status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
    ok: { type: Boolean },
    /** PipelineStageResult[] returned by runPipeline. */
    results: { type: Schema.Types.Mixed },
    /**
     * The exact final SSE `done` (or `error`) payload streamed to the caller,
     * already redacted — later read APIs return this verbatim to stay
     * format-compatible with the live trigger response.
     */
    donePayload: { type: Schema.Types.Mixed },
    error: { type: String },
    // From the SDK result message for this run.
    numTurns: { type: Number },
    totalCostUsd: { type: Number },
    stopReason: { type: String },
    usage: { type: Schema.Types.Mixed },
    modelUsage: { type: Schema.Types.Mixed },
    permissionDenials: { type: Schema.Types.Mixed },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    durationMs: { type: Number },
  },
  { timestamps: true },
);
runSchema.index({ sessionId: 1, createdAt: 1 });
runSchema.index({ userId: 1, createdAt: -1 });

const messageSchema = new Schema(
  {
    ...schemaVersionField,
    sessionId: { type: String, required: true },
    runId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: String, required: true },
    /** Position within the run — replay order, no timestamp ties. */
    seq: { type: Number, required: true },
    /** SDK message uuid (user messages may omit it). */
    uuid: { type: String },
    /** SDKMessage.type — the SSE event name a replay API re-emits. */
    event: { type: String, required: true },
    subtype: { type: String },
    role: { type: String },
    model: { type: String },
    parentToolUseId: { type: String },
    /** Extracted plain text (assistant text blocks / result summary) for previews and search. */
    text: { type: String },
    /** tool_use ids initiated by this message — join key into tool_calls. */
    toolUseIds: { type: [String], default: undefined },
    /** Per-message API usage snapshot when present (assistant/result messages). */
    usage: { type: Schema.Types.Mixed },
    /** Full redacted SDKMessage — the SSE `data` for format-compatible replay. */
    payload: { type: Schema.Types.Mixed, required: true },
    /** SDK-reported timestamp when present, else receive time. */
    timestamp: { type: Date },
  },
  { timestamps: true },
);
messageSchema.index({ runId: 1, seq: 1 });
messageSchema.index({ sessionId: 1, createdAt: 1 });
messageSchema.index({ uuid: 1 }, { sparse: true });

const toolCallSchema = new Schema(
  {
    ...schemaVersionField,
    /** The API's tool_use block id — what tool_result blocks point back at. */
    toolUseId: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true },
    runId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: String, required: true },
    name: { type: String, required: true },
    /** Coarse grouping (file_change | git | command | read | mcp | other) — see toolCategory. */
    category: { type: String, required: true },
    input: { type: Schema.Types.Mixed },
    /** tool_result content sent back to the model. */
    result: { type: Schema.Types.Mixed },
    /** SDKUserMessage.tool_use_result — the tool's structured output when the SDK provides one. */
    structuredResult: { type: Schema.Types.Mixed },
    isError: { type: Boolean },
    status: { type: String, enum: ['pending', 'completed', 'error'], default: 'pending' },
    /** Set when this call ran inside a subagent (Task tool). */
    parentToolUseId: { type: String },
    requestedAt: { type: Date, required: true },
    completedAt: { type: Date },
  },
  { timestamps: true },
);
toolCallSchema.index({ sessionId: 1, requestedAt: 1 });
// "All file changes / git operations in this session" without a payload scan.
toolCallSchema.index({ sessionId: 1, category: 1 });

const usageRecordSchema = new Schema(
  {
    ...schemaVersionField,
    userId: { type: String, required: true },
    userEmail: { type: String },
    sessionId: { type: String, required: true },
    runId: { type: Schema.Types.ObjectId, required: true },
    ...usageTotalsFields,
    /** Per-model breakdown for this run (SDK `modelUsage`). */
    modelUsage: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// The quota query: sum usage for a user within a billing window.
usageRecordSchema.index({ userId: 1, createdAt: -1 });

/**
 * One named block of standing, repo-specific instructions managed via the
 * /v1/repo-instructions CRUD API (src/server/routes/v1/repo-instructions.ts)
 * rather than by committing a file to the target repo. Associated with the
 * repo only, not a caller — every authenticated caller who triggers a given
 * repo shares the same instruction set for it, the same way a file committed
 * to that repo would apply regardless of who runs the agent against it.
 * `repoSlug` (same derivation as `sessions`/`runs`, see
 * src/mcp/git/workspace.ts) is the lookup key `/v1/trigger` uses to find
 * every enabled entry for a repo without needing exact `repoUrl` string
 * equality (e.g. a trailing `.git` or differing scheme).
 *
 * Uniqueness of `(repoSlug, name)` is enforced in the query layer
 * (src/db/repoInstructions.ts), not by a unique index: `connectMongo` sets
 * `autoIndex: false` and indexes are normally owned by a migration (see
 * "Migrations" in CLAUDE.md) — this collection intentionally ships without
 * one for now (local-only), so don't rely on a DB-level unique constraint
 * existing until a migration adds it.
 */
const repoInstructionSchema = new Schema(
  {
    ...schemaVersionField,
    repoUrl: { type: String, required: true },
    repoSlug: { type: String, required: true },
    name: { type: String, required: true },
    content: { type: String, required: true },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);
// "Every enabled instruction for this repo" — the /v1/trigger lookup.
repoInstructionSchema.index({ repoSlug: 1 });

export type SessionDoc = InferSchemaType<typeof sessionSchema>;
export type RunDoc = InferSchemaType<typeof runSchema>;
export type MessageDoc = InferSchemaType<typeof messageSchema>;
export type ToolCallDoc = InferSchemaType<typeof toolCallSchema>;
export type UsageRecordDoc = InferSchemaType<typeof usageRecordSchema>;
export type RepoInstructionDoc = InferSchemaType<typeof repoInstructionSchema>;

// `models.X ?? model(...)` keeps re-imports (test workers, hot reload) from
// throwing OverwriteModelError on the shared mongoose instance. The casts
// collapse the `existing-model | fresh-model` union back to one callable
// model type.
export const SessionModel = (models.Session ??
  model('Session', sessionSchema)) as Model<SessionDoc>;
export const RunModel = (models.Run ?? model('Run', runSchema)) as Model<RunDoc>;
export const MessageModel = (models.Message ??
  model('Message', messageSchema)) as Model<MessageDoc>;
export const ToolCallModel = (models.ToolCall ??
  model('ToolCall', toolCallSchema, 'tool_calls')) as Model<ToolCallDoc>;
export const UsageRecordModel = (models.UsageRecord ??
  model('UsageRecord', usageRecordSchema, 'usage_records')) as Model<UsageRecordDoc>;
export const RepoInstructionModel = (models.RepoInstruction ??
  model(
    'RepoInstruction',
    repoInstructionSchema,
    'repo_instructions',
  )) as Model<RepoInstructionDoc>;
