/**
 * Read routes over the persisted conversations (src/db):
 *
 *   GET /v1/sessions                         — the caller's conversations, paginated
 *   GET /v1/sessions/:sessionId/messages     — one conversation's messages, paginated,
 *                                              optionally narrowed to a single run
 *                                              (?runId=) and/or one or more SDK event
 *                                              types (?events=) — e.g. ?events=assistant
 *                                              to skip system/thinking noise.
 *   GET /v1/sessions/:sessionId/tool-calls   — one conversation's tool calls (tool_use
 *                                              correlated with its tool_result), paginated,
 *                                              optionally narrowed to a single run
 *                                              (?runId=) and/or a tool category
 *                                              (?category=). A dedicated endpoint over the
 *                                              `tool_calls` collection instead of another
 *                                              `messages` filter, since a tool call is a
 *                                              different shape (input/result/status, not an
 *                                              SDK event) and this is the query surface
 *                                              `tool_calls`'s indexes were built for
 *                                              (src/db/models.ts).
 *
 * All three are scoped to the authenticated caller: the userId from the
 * gateway-verified JWT is baked into every query (src/db/queries.ts), so one
 * user can never page through another user's sessions — a session that
 * exists but belongs to someone else 404s identically to one that doesn't
 * exist. All three follow the shared envelope + pagination contract
 * (src/server/schemas/common.ts).
 */
import { callerIdentity } from '@/auth/index.js';
import type { SessionQueries } from '@/db/index.js';
import {
  errorBody,
  errorResponseSchema,
  type FastifyZodInstance,
  paginatedResponseSchema,
  paginationMeta,
  paginationQuerySchema,
} from '../../schemas/common.js';
import {
  conversationMessageSchema,
  conversationQuerySchema,
  sessionParamsSchema,
  sessionSummarySchema,
  toolCallQuerySchema,
  toolCallSchema,
} from '../../schemas/sessions.js';

export interface SessionRouteOptions {
  queries: SessionQueries;
}

export function registerSessionRoutes(app: FastifyZodInstance, options: SessionRouteOptions): void {
  app.get(
    '/sessions',
    {
      schema: {
        description:
          "Lists the authenticated caller's conversations (sessions), most recently active " +
          'first. Returns minimal summaries — fetch a conversation body via ' +
          '/v1/sessions/{sessionId}/messages.',
        tags: ['sessions'],
        querystring: paginationQuerySchema,
        response: {
          200: paginatedResponseSchema(sessionSummarySchema),
          400: errorResponseSchema,
          401: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: app.authenticate,
    },
    async (request) => {
      const { userId } = callerIdentity(request.user);
      const { items, total } = await options.queries.listSessions(userId, request.query);
      return {
        success: true as const,
        data: items,
        pagination: paginationMeta(request.query, total),
      };
    },
  );

  app.get(
    '/sessions/:sessionId/messages',
    {
      schema: {
        description:
          'Returns one conversation in order (paginated), optionally narrowed to a single ' +
          'trigger run via ?runId= and/or one or more SDK event types via ?events= (e.g. ' +
          '?events=assistant to skip system/thinking noise; repeat the param or ' +
          'comma-separate for more than one). The first item of each run is a ' +
          "synthetic `user_prompt` event carrying the caller's original prompt — the Agent " +
          'SDK never streams that back as a message of its own, so without it a stored ' +
          'conversation shows only the assistant/tool activity with no record of what was ' +
          'asked. Every other item carries the same `event` name and redacted `payload` the ' +
          'live /v1/trigger SSE stream emitted, so stored conversations replay through the ' +
          'same client rendering path. For tool call details (input/result/status), use ' +
          'GET /v1/sessions/{sessionId}/tool-calls instead of scanning payloads here. 404 ' +
          'when the session does not exist for the authenticated caller.',
        tags: ['sessions'],
        params: sessionParamsSchema,
        querystring: conversationQuerySchema,
        response: {
          200: paginatedResponseSchema(conversationMessageSchema),
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: app.authenticate,
    },
    async (request, reply) => {
      const { userId } = callerIdentity(request.user);
      const { sessionId } = request.params;
      const { runId, events, ...page } = request.query;
      const result = await options.queries.listConversation(userId, sessionId, runId, events, page);
      if (result === null) {
        return reply
          .code(404)
          .send(errorBody('NOT_FOUND', `No session "${sessionId}" for the authenticated user`));
      }
      return {
        success: true as const,
        data: result.items,
        pagination: paginationMeta(page, result.total),
      };
    },
  );

  app.get(
    '/sessions/:sessionId/tool-calls',
    {
      schema: {
        description:
          "Returns one conversation's tool calls in chronological order (paginated) — each " +
          'item is a tool_use correlated with its tool_result (name, category, input, result, ' +
          'status), the queryable detail that /v1/sessions/{sessionId}/messages only carries ' +
          'buried inside message payloads. Optionally narrowed to a single trigger run via ' +
          '?runId= and/or a tool category via ?category= (file_change | git | command | read ' +
          '| mcp | other). 404 when the session does not exist for the authenticated caller.',
        tags: ['sessions'],
        params: sessionParamsSchema,
        querystring: toolCallQuerySchema,
        response: {
          200: paginatedResponseSchema(toolCallSchema),
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: app.authenticate,
    },
    async (request, reply) => {
      const { userId } = callerIdentity(request.user);
      const { sessionId } = request.params;
      const { runId, category, ...page } = request.query;
      const result = await options.queries.listToolCalls(userId, sessionId, runId, category, page);
      if (result === null) {
        return reply
          .code(404)
          .send(errorBody('NOT_FOUND', `No session "${sessionId}" for the authenticated user`));
      }
      return {
        success: true as const,
        data: result.items,
        pagination: paginationMeta(page, result.total),
      };
    },
  );
}
