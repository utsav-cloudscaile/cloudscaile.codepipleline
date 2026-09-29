/**
 * Zod schemas for the /v1/sessions read routes. The item schemas mirror the
 * DTO interfaces in `src/db/queries.ts` (the source of truth for the wire
 * shape) — the `satisfies z.ZodType<...>` checks keep the two from drifting.
 */
import { z } from 'zod';
import type { ConversationMessage, SessionSummary, ToolCallSummary } from '@/db/index.js';
import { paginationQuerySchema } from './common.js';

export const sessionSummarySchema = z
  .object({
    sessionId: z.string().describe('Agent SDK session id — pass to /v1/trigger to resume.'),
    title: z.string().optional().describe('Derived from the first prompt of the conversation.'),
    status: z.string().describe('running | completed | failed.'),
    repoUrl: z.string().optional(),
    repoSlug: z.string().optional(),
    model: z.string().optional(),
    runCount: z.number().int(),
    totalCostUsd: z.number(),
    lastRunAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime().optional(),
  })
  .describe('Minimal per-conversation summary for list views.') satisfies z.ZodType<SessionSummary>;

export const conversationMessageSchema = z
  .object({
    id: z.string(),
    runId: z.string().describe('The /v1/trigger invocation this message belongs to.'),
    seq: z.number().int().describe('Order within the run.'),
    event: z.string().describe('SDK message type — the SSE event name the trigger stream used.'),
    subtype: z.string().optional(),
    role: z.string().optional(),
    model: z.string().optional(),
    text: z.string().optional().describe('Extracted plain text, when the message carries any.'),
    timestamp: z.iso.datetime().optional(),
    payload: z.unknown().describe('Full redacted SDK message — the SSE `data` payload.'),
  })
  .describe(
    'One stored SDK message; `event` + `payload` match the live SSE frames byte-for-byte.',
  ) satisfies z.ZodType<ConversationMessage>;

export const toolCallSchema = z
  .object({
    id: z.string(),
    runId: z.string().describe('The /v1/trigger invocation this tool call belongs to.'),
    toolUseId: z.string().describe("The API's tool_use block id."),
    name: z.string().describe('Tool name, e.g. Edit, Bash, mcp__git__git_push.'),
    category: z
      .string()
      .describe('Coarse grouping: file_change | git | command | read | mcp | other.'),
    input: z.unknown().optional(),
    result: z.unknown().optional().describe('tool_result content sent back to the model.'),
    structuredResult: z
      .unknown()
      .optional()
      .describe("The tool's structured output (SDKUserMessage.tool_use_result), when provided."),
    isError: z.boolean().optional(),
    status: z.string().describe('pending | completed | error.'),
    parentToolUseId: z.string().optional().describe('Set when this call ran inside a subagent.'),
    requestedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
  })
  .describe('One tool_use correlated with its tool_result.') satisfies z.ZodType<ToolCallSummary>;

export const sessionParamsSchema = z.object({
  sessionId: z.string().min(1).describe('Agent SDK session id.'),
});

const runIdQuerySchema = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, 'runId must be a 24-character hex ObjectId')
  .optional();

/**
 * Accepts a single value, a repeated query param (`?events=a&events=b`), or a
 * comma-separated value (`?events=a,b`) and normalizes all three into a
 * string array — Fastify's query parser only produces an array itself when
 * the param repeats, so a single occurrence otherwise arrives as a bare
 * string.
 */
const stringListQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }
    const values = (Array.isArray(value) ? value : [value]).flatMap((entry) => entry.split(','));
    const trimmed = values.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    return trimmed.length > 0 ? trimmed : undefined;
  });

export const conversationQuerySchema = paginationQuerySchema.extend({
  runId: runIdQuerySchema.describe('Narrow the conversation to a single trigger run.'),
  events: stringListQuerySchema.describe(
    'Narrow to one or more SDK event/message types (e.g. assistant, user, system, result, ' +
      'user_prompt) — the same values the live SSE stream used as its event name. Repeat the ' +
      'param (?events=assistant&events=result) or comma-separate (?events=assistant,result) ' +
      'for more than one.',
  ),
});

export const toolCallQuerySchema = paginationQuerySchema.extend({
  runId: runIdQuerySchema.describe('Narrow the tool calls to a single trigger run.'),
  category: z
    .string()
    .optional()
    .describe(
      'Narrow to a single tool category: file_change | git | command | read | mcp | other.',
    ),
});
