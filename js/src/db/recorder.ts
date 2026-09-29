/**
 * Best-effort persistence of one /trigger run: the server creates a recorder
 * per request, feeds it every SDK message (the same stream it forwards as
 * SSE), and finalizes it with the exact `done`/`error` payload it sent the
 * caller.
 *
 * Two deliberate properties:
 *
 * - **Never blocks or breaks a run.** `record()` is synchronous fire-and-
 *   forget; writes are serialized on an internal promise chain (so `seq`
 *   ordering holds) and every operation catches + logs its own failure. A
 *   MongoDB outage mid-run costs history, not the pipeline run. When no
 *   connection exists at all (tests, or `connectMongo` was never called),
 *   `createRunRecorder` returns a no-op recorder instead of letting mongoose
 *   buffer writes that would never land.
 *
 * - **Persists what the caller saw.** Payloads are passed through the same
 *   `redact` the SSE stream uses before they are stored, so the git token the
 *   stage prompt embeds (see buildStagePrompt, src/server) can never reach
 *   the database either.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
// Default import — see the CJS/ESM note in models.ts.
import mongoose from 'mongoose';
import { isMongoConnected } from './connection.js';
import {
  deriveTitle,
  extractMessageFacets,
  toolCategory,
  type UsageTotals,
  usageTotalsFromResult,
} from './extract.js';
import { MessageModel, RunModel, SessionModel, ToolCallModel, UsageRecordModel } from './models.js';

export interface RunRecorderContext {
  userId: string;
  userEmail?: string;
  repoSlug: string;
  /** The /trigger request body as received (no auth material). */
  request: {
    prompt: string;
    repoUrl: string;
    sessionId?: string;
    dir?: string;
    refDirs?: Array<{ path: string }>;
  };
  /** Applied to every persisted payload — same redaction as the SSE stream. */
  redact: (text: string) => string;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

export interface RunRecorder {
  /** Persist one SDK message. Synchronous fire-and-forget; safe to call from onMessage. */
  record(message: SDKMessage): void;
  /**
   * Persist the final SSE payload (`done` or `error`) and close out the run
   * and session docs. Resolves once every queued write has settled.
   */
  finalize(event: 'done' | 'error', payload: Record<string, unknown>): Promise<void>;
}

const NOOP_RECORDER: RunRecorder = {
  record: () => {},
  finalize: async () => {},
};

export function createRunRecorder(context: RunRecorderContext): RunRecorder {
  if (!isMongoConnected()) {
    context.log?.warn(
      { repoSlug: context.repoSlug },
      'MongoDB not connected — this run will not be persisted',
    );
    return NOOP_RECORDER;
  }

  const runId = new mongoose.Types.ObjectId();
  const startedAt = new Date();
  let sessionId = context.request.sessionId;
  let sessionEnsured = false;
  let seq = 0;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>): void => {
    chain = chain.then(op).catch((error: unknown) => {
      context.log?.warn({ error, runId: runId.toHexString() }, 'failed to persist run event');
    });
  };

  /** Strips secrets the same way the SSE stream does, via a JSON round-trip. */
  const sanitize = <T>(value: T): T => JSON.parse(context.redact(JSON.stringify(value))) as T;

  const ensureSessionAndRun = async (): Promise<void> => {
    if (sessionEnsured || sessionId === undefined) {
      return;
    }
    sessionEnsured = true;
    await SessionModel.updateOne(
      { sessionId },
      {
        $setOnInsert: {
          userId: context.userId,
          ...(context.userEmail !== undefined && { userEmail: context.userEmail }),
          title: deriveTitle(context.request.prompt),
          repoUrl: context.request.repoUrl,
          repoSlug: context.repoSlug,
        },
        $set: { status: 'running', lastRunAt: startedAt },
        $inc: { runCount: 1 },
      },
      { upsert: true },
    );
    await RunModel.create({
      _id: runId,
      sessionId,
      userId: context.userId,
      ...(context.userEmail !== undefined && { userEmail: context.userEmail }),
      request: sanitize(context.request),
      status: 'running',
      startedAt,
    });
    // The Agent SDK never streams the caller's own prompt back as an
    // SDKMessage — query() only emits what the model/tools produce in
    // response to it — so without this, a replayed conversation shows the
    // assistant/tool activity with no record of what was actually asked.
    // seq 0 sorts before every real message from this run (persistMessage
    // starts seq at 1); event/subtype are namespaced away from the SDK's own
    // 'user' message type (tool results) so a client can tell the two apart.
    await MessageModel.create({
      sessionId,
      runId,
      userId: context.userId,
      seq: 0,
      event: 'user_prompt',
      subtype: 'initial_prompt',
      role: 'user',
      text: sanitize(context.request.prompt),
      timestamp: startedAt,
      payload: sanitize({
        type: 'user_prompt',
        prompt: context.request.prompt,
        repoUrl: context.request.repoUrl,
        ...(context.request.dir !== undefined && { dir: context.request.dir }),
        ...(context.request.refDirs !== undefined && { refDirs: context.request.refDirs }),
      }),
    });
  };

  const persistMessage = async (message: SDKMessage, messageSeq: number): Promise<void> => {
    sessionId ??= 'session_id' in message ? message.session_id : undefined;
    await ensureSessionAndRun();
    if (sessionId === undefined) {
      // No session id anywhere yet (shouldn't happen — system/init carries
      // one and arrives first). Drop rather than invent an identifier the
      // resume flow could never match.
      return;
    }
    // Narrowed copy — `sessionId` is a captured `let`, so TS forgets the
    // undefined-check above across the awaits below.
    const sid = sessionId;

    const facets = extractMessageFacets(message);
    const payload = sanitize(message);

    if (message.type === 'system' && message.subtype === 'init') {
      await SessionModel.updateOne(
        { sessionId: sid },
        {
          $set: {
            model: message.model,
            claudeCodeVersion: message.claude_code_version,
            permissionMode: message.permissionMode,
            cwd: message.cwd,
            tools: message.tools,
            mcpServers: message.mcp_servers,
          },
        },
      );
    }

    await MessageModel.create({
      sessionId: sid,
      runId,
      userId: context.userId,
      seq: messageSeq,
      event: message.type,
      payload,
      timestamp: facets.timestamp ?? new Date(),
      ...(facets.uuid !== undefined && { uuid: facets.uuid }),
      ...(facets.subtype !== undefined && { subtype: facets.subtype }),
      ...(facets.role !== undefined && { role: facets.role }),
      ...(facets.model !== undefined && { model: facets.model }),
      ...(facets.parentToolUseId !== undefined && { parentToolUseId: facets.parentToolUseId }),
      ...(facets.text !== undefined && { text: sanitize(facets.text) }),
      ...(facets.toolUses.length > 0 && {
        toolUseIds: facets.toolUses.map((toolUse) => toolUse.toolUseId),
      }),
      ...(facets.usage !== undefined && { usage: facets.usage }),
    });

    if (facets.toolUses.length > 0) {
      await ToolCallModel.bulkWrite(
        facets.toolUses.map((toolUse) => ({
          updateOne: {
            filter: { toolUseId: toolUse.toolUseId },
            update: {
              $setOnInsert: {
                sessionId: sid,
                runId,
                userId: context.userId,
                name: toolUse.name,
                category: toolCategory(toolUse.name),
                input: sanitize(toolUse.input),
                ...(facets.parentToolUseId !== undefined && {
                  parentToolUseId: facets.parentToolUseId,
                }),
                status: 'pending' as const,
                requestedAt: facets.timestamp ?? new Date(),
              },
            },
            upsert: true,
          },
        })),
      );
    }

    if (facets.toolResults.length > 0) {
      // tool_use_result is the structured output of *the* tool this user
      // message answers — only attributable when the message carries exactly
      // one tool_result.
      const structuredResult =
        facets.toolResults.length === 1 && message.type === 'user'
          ? message.tool_use_result
          : undefined;
      for (const toolResult of facets.toolResults) {
        await ToolCallModel.updateOne(
          { toolUseId: toolResult.toolUseId },
          {
            $set: {
              result: sanitize(toolResult.content),
              isError: toolResult.isError,
              status: toolResult.isError ? 'error' : 'completed',
              completedAt: facets.timestamp ?? new Date(),
              ...(structuredResult !== undefined && {
                structuredResult: sanitize(structuredResult),
              }),
            },
          },
        );
      }
    }

    if (message.type === 'result') {
      const totals = usageTotalsFromResult(message);
      await RunModel.updateOne(
        { _id: runId },
        {
          $set: {
            numTurns: totals.numTurns,
            totalCostUsd: totals.costUsd,
            stopReason: message.stop_reason ?? undefined,
            usage: message.usage,
            modelUsage: message.modelUsage,
            permissionDenials: message.permission_denials,
          },
        },
      );
      await SessionModel.updateOne({ sessionId: sid }, { $inc: prefixTotals(totals) });
      await UsageRecordModel.create({
        userId: context.userId,
        ...(context.userEmail !== undefined && { userEmail: context.userEmail }),
        sessionId: sid,
        runId,
        ...totals,
        modelUsage: message.modelUsage,
      });
    }
  };

  return {
    record(message: SDKMessage): void {
      seq += 1;
      const messageSeq = seq;
      enqueue(() => persistMessage(message, messageSeq));
    },

    async finalize(event, payload): Promise<void> {
      enqueue(async () => {
        await ensureSessionAndRun();
        if (sessionId === undefined) {
          return;
        }
        const finishedAt = new Date();
        const ok = event === 'done' && payload.ok === true;
        const status = ok ? 'completed' : 'failed';
        await RunModel.updateOne(
          { _id: runId },
          {
            $set: {
              status,
              ok,
              donePayload: sanitize(payload),
              finishedAt,
              durationMs: finishedAt.getTime() - startedAt.getTime(),
              ...(event === 'error' &&
                typeof payload.error === 'string' && { error: payload.error }),
              ...(event === 'done' &&
                payload.results !== undefined && { results: sanitize(payload.results) }),
            },
          },
        );
        await SessionModel.updateOne({ sessionId }, { $set: { status, lastRunAt: finishedAt } });
      });
      await chain;
    },
  };
}

/** Maps flat usage totals onto `$inc`-able `totals.*` paths on the session doc. */
function prefixTotals(totals: UsageTotals): Record<string, number> {
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [`totals.${key}`, value]));
}
