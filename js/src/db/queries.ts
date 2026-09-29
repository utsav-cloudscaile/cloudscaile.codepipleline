/**
 * Read-side data access for the /v1 API routes. Every query is scoped by
 * `userId` (the gateway-verified caller) — ownership is enforced here, in the
 * database filter, not in route handlers, so a route can't accidentally leak
 * another user's conversations by forgetting a check.
 *
 * The `SessionQueries` interface is what the server actually depends on
 * (`BuildServerOptions.sessionQueries`) — tests inject a fake, the same seam
 * pattern as `runPipelineFn`. DTOs here are plain JSON (ids/dates as
 * strings): they're the wire format the route schemas mirror
 * (src/server/schemas/sessions.ts), so the mapping from mongoose docs
 * happens exactly once, in this file.
 */
import mongoose from 'mongoose';
import { isMongoConnected } from './connection.js';
import { MessageModel, SessionModel, ToolCallModel } from './models.js';

export interface PageRequest {
  /** 1-based. */
  page: number;
  limit: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

/**
 * Minimal per-conversation summary for list views. Optional fields carry
 * `| undefined` so the shape matches what the zod route schemas infer
 * (src/server/schemas/sessions.ts) under exactOptionalPropertyTypes — that's
 * what lets the schemas `satisfies z.ZodType<...>` these interfaces.
 */
export interface SessionSummary {
  sessionId: string;
  title?: string | undefined;
  status: string;
  repoUrl?: string | undefined;
  repoSlug?: string | undefined;
  model?: string | undefined;
  runCount: number;
  totalCostUsd: number;
  lastRunAt?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

/**
 * One persisted SDK message. `event` + `payload` are the same pair the
 * trigger route streams as SSE frames (`event: <event>`, `data: <payload>`),
 * so a client can replay a stored conversation through the exact rendering
 * path it uses for live runs.
 */
export interface ConversationMessage {
  id: string;
  runId: string;
  seq: number;
  event: string;
  subtype?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  text?: string | undefined;
  timestamp?: string | undefined;
  payload: unknown;
}

/**
 * One persisted tool call: a tool_use correlated with its tool_result, kept
 * in its own indexed collection (`tool_calls`) so "what changed" / "what was
 * committed" is a direct query instead of scanning every message payload for
 * `tool_use`/`tool_result` blocks — see the `/v1/sessions/:sessionId/messages`
 * route's own doc comment for why that scan is otherwise necessary.
 */
export interface ToolCallSummary {
  id: string;
  runId: string;
  toolUseId: string;
  name: string;
  /** Coarse grouping — file_change | git | command | read | mcp | other (see toolCategory). */
  category: string;
  input?: unknown;
  /** tool_result content sent back to the model. */
  result?: unknown;
  /** SDKUserMessage.tool_use_result — the tool's structured output, when the SDK provided one. */
  structuredResult?: unknown;
  isError?: boolean | undefined;
  status: string;
  /** Set when this call ran inside a subagent (Task tool). */
  parentToolUseId?: string | undefined;
  requestedAt?: string | undefined;
  completedAt?: string | undefined;
}

export interface SessionQueries {
  /** The caller's sessions, most recently active first. */
  listSessions(userId: string, page: PageRequest): Promise<Page<SessionSummary>>;
  /**
   * Messages of one of the caller's sessions in conversation order,
   * optionally narrowed to a single run and/or one or more SDK event types
   * (e.g. `['assistant']`, to skip system/thinking noise — matched with an
   * OR). Returns null when the session doesn't exist *for this user* —
   * deliberately indistinguishable from "exists but belongs to someone
   * else", so the route's 404 leaks nothing.
   */
  listConversation(
    userId: string,
    sessionId: string,
    runId: string | undefined,
    events: string[] | undefined,
    page: PageRequest,
  ): Promise<Page<ConversationMessage> | null>;
  /**
   * Tool calls of one of the caller's sessions in chronological order,
   * optionally narrowed to a single run and/or a tool category. Same
   * ownership/404 semantics as `listConversation`.
   */
  listToolCalls(
    userId: string,
    sessionId: string,
    runId: string | undefined,
    category: string | undefined,
    page: PageRequest,
  ): Promise<Page<ToolCallSummary> | null>;
}

/** Read routes fail with a clean 503 envelope when the DB is down, not a timeout. */
export function requireConnected(): void {
  if (!isMongoConnected()) {
    throw Object.assign(new Error('Persistence store is unavailable'), { statusCode: 503 });
  }
}

const iso = (value: unknown): string | undefined =>
  value instanceof Date ? value.toISOString() : undefined;

export const sessionQueries: SessionQueries = {
  async listSessions(userId, { page, limit }) {
    requireConnected();
    const filter = { userId };
    const [docs, total] = await Promise.all([
      SessionModel.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SessionModel.countDocuments(filter),
    ]);
    const items = docs.map((doc): SessionSummary => {
      const lastRunAt = iso(doc.lastRunAt);
      const createdAt = iso(doc.createdAt);
      const updatedAt = iso(doc.updatedAt);
      return {
        sessionId: doc.sessionId,
        status: doc.status ?? 'running',
        runCount: doc.runCount ?? 0,
        totalCostUsd: doc.totals?.costUsd ?? 0,
        ...(doc.title != null && { title: doc.title }),
        ...(doc.repoUrl != null && { repoUrl: doc.repoUrl }),
        ...(doc.repoSlug != null && { repoSlug: doc.repoSlug }),
        ...(doc.model != null && { model: doc.model }),
        ...(lastRunAt !== undefined && { lastRunAt }),
        ...(createdAt !== undefined && { createdAt }),
        ...(updatedAt !== undefined && { updatedAt }),
      };
    });
    return { items, total };
  },

  async listConversation(userId, sessionId, runId, events, { page, limit }) {
    requireConnected();
    // Ownership gate: the session must exist under this caller's userId.
    const session = await SessionModel.findOne({ sessionId, userId }).select({ _id: 1 }).lean();
    if (session === null) {
      return null;
    }
    const filter = {
      sessionId,
      ...(runId !== undefined && { runId: new mongoose.Types.ObjectId(runId) }),
      ...(events !== undefined && { event: { $in: events } }),
    };
    const [docs, total] = await Promise.all([
      MessageModel.find(filter)
        .sort({ createdAt: 1, seq: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      MessageModel.countDocuments(filter),
    ]);
    const items = docs.map((doc): ConversationMessage => {
      const timestamp = iso(doc.timestamp);
      return {
        id: String(doc._id),
        runId: String(doc.runId),
        seq: doc.seq,
        event: doc.event,
        payload: doc.payload,
        ...(doc.subtype != null && { subtype: doc.subtype }),
        ...(doc.role != null && { role: doc.role }),
        ...(doc.model != null && { model: doc.model }),
        ...(doc.text != null && { text: doc.text }),
        ...(timestamp !== undefined && { timestamp }),
      };
    });
    return { items, total };
  },

  async listToolCalls(userId, sessionId, runId, category, { page, limit }) {
    requireConnected();
    // Ownership gate: the session must exist under this caller's userId.
    const session = await SessionModel.findOne({ sessionId, userId }).select({ _id: 1 }).lean();
    if (session === null) {
      return null;
    }
    const filter = {
      sessionId,
      ...(runId !== undefined && { runId: new mongoose.Types.ObjectId(runId) }),
      ...(category !== undefined && { category }),
    };
    const [docs, total] = await Promise.all([
      ToolCallModel.find(filter)
        .sort({ requestedAt: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ToolCallModel.countDocuments(filter),
    ]);
    const items = docs.map((doc): ToolCallSummary => {
      const requestedAt = iso(doc.requestedAt);
      const completedAt = iso(doc.completedAt);
      return {
        id: String(doc._id),
        runId: String(doc.runId),
        toolUseId: doc.toolUseId,
        name: doc.name,
        category: doc.category,
        status: doc.status ?? 'pending',
        ...(doc.input != null && { input: doc.input }),
        ...(doc.result != null && { result: doc.result }),
        ...(doc.structuredResult != null && { structuredResult: doc.structuredResult }),
        ...(doc.isError != null && { isError: doc.isError }),
        ...(doc.parentToolUseId != null && { parentToolUseId: doc.parentToolUseId }),
        ...(requestedAt !== undefined && { requestedAt }),
        ...(completedAt !== undefined && { completedAt }),
      };
    });
    return { items, total };
  },
};
