import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/config/index.js';
import type {
  ConversationMessage,
  SessionQueries,
  SessionSummary,
  ToolCallSummary,
} from '@/db/index.js';
import { DEFAULT_POLICY } from '@/guardrails/index.js';
import { buildServer } from '@/server/index.js';

const config: AppConfig = {
  policyPath: './pipeline.policy.json',
  policy: {},
  logLevel: 'error',
  model: 'claude-haiku-4-5-20251001',
  git: { token: 'test-token', email: 'bot@example.com', name: 'Pipeline Bot' },
  trigger: { port: 0, host: '127.0.0.1' },
  usageLimits: { windowHours: 24 },
  mongo: { uri: 'mongodb://localhost:27017/code-pipeline-test', autoMigrate: false },
};

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

const authHeaders = {
  authorization: `Bearer ${makeJwt({ sub: 'user-1', email: 'user@example.com' })}`,
};

const sampleSession: SessionSummary = {
  sessionId: 'session-1',
  title: 'Add a health check route',
  status: 'completed',
  repoUrl: 'https://github.com/acme/widgets.git',
  repoSlug: 'acme-widgets',
  model: 'claude-sonnet-5',
  runCount: 2,
  totalCostUsd: 0.42,
  lastRunAt: '2026-07-23T10:00:00.000Z',
  createdAt: '2026-07-22T09:00:00.000Z',
  updatedAt: '2026-07-23T10:00:00.000Z',
};

const sampleMessage: ConversationMessage = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  runId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  seq: 1,
  event: 'assistant',
  role: 'assistant',
  text: 'Editing the file now.',
  timestamp: '2026-07-23T10:00:01.000Z',
  payload: { type: 'assistant', session_id: 'session-1' },
};

const sampleToolCall: ToolCallSummary = {
  id: 'dddddddddddddddddddddddd',
  runId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  toolUseId: 'toolu_01abc',
  name: 'Edit',
  category: 'file_change',
  input: { file_path: 'src/routes/health.ts' },
  result: 'ok',
  isError: false,
  status: 'completed',
  requestedAt: '2026-07-23T10:00:01.000Z',
  completedAt: '2026-07-23T10:00:02.000Z',
};

describe('/v1/sessions read routes', () => {
  let app: FastifyInstance;
  let queries: { [K in keyof SessionQueries]: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    queries = {
      listSessions: vi.fn().mockResolvedValue({ items: [sampleSession], total: 45 }),
      listConversation: vi.fn().mockResolvedValue({ items: [sampleMessage], total: 1 }),
      listToolCalls: vi.fn().mockResolvedValue({ items: [sampleToolCall], total: 1 }),
    };
    app = await buildServer({
      config,
      mcpServers: {},
      policy: { ...DEFAULT_POLICY, allowedTools: ['Read'] },
      logger: false,
      runPipelineFn: vi.fn() as unknown as typeof import('@/pipeline/index.js').runPipeline,
      sessionQueries: queries as unknown as SessionQueries,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /v1/sessions', () => {
    it('returns 401 in the shared error envelope without a token', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/sessions' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      });
      expect(queries.listSessions).not.toHaveBeenCalled();
    });

    it('returns the caller-scoped page in the success envelope with pagination meta', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions?page=2&limit=20',
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        data: [sampleSession],
        pagination: { page: 2, limit: 20, totalItems: 45, totalPages: 3 },
      });
      // userId comes from the JWT — the query layer bakes it into the filter.
      expect(queries.listSessions).toHaveBeenCalledWith('user-1', { page: 2, limit: 20 });
    });

    it('applies the shared pagination defaults (page 1, limit 20)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(queries.listSessions).toHaveBeenCalledWith('user-1', { page: 1, limit: 20 });
    });

    it('rejects a limit above the shared 100 cap with the error envelope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions?limit=500',
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
      expect(queries.listSessions).not.toHaveBeenCalled();
    });

    it('maps a persistence-unavailable failure to a 503 error envelope', async () => {
      queries.listSessions.mockRejectedValue(
        Object.assign(new Error('Persistence store is unavailable'), { statusCode: 503 }),
      );
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Persistence store is unavailable' },
      });
    });
  });

  describe('GET /v1/sessions/:sessionId/messages', () => {
    it('returns the conversation page in the success envelope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/messages',
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        data: [sampleMessage],
        pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1 },
      });
      expect(queries.listConversation).toHaveBeenCalledWith(
        'user-1',
        'session-1',
        undefined,
        undefined,
        { page: 1, limit: 20 },
      );
    });

    it('passes a runId filter through to the query layer', async () => {
      const runId = 'cccccccccccccccccccccccc';
      await app.inject({
        method: 'GET',
        url: `/v1/sessions/session-1/messages?runId=${runId}`,
        headers: authHeaders,
      });
      expect(queries.listConversation).toHaveBeenCalledWith(
        'user-1',
        'session-1',
        runId,
        undefined,
        { page: 1, limit: 20 },
      );
    });

    it('passes a single events filter through to the query layer as an array', async () => {
      await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/messages?events=assistant',
        headers: authHeaders,
      });
      expect(queries.listConversation).toHaveBeenCalledWith(
        'user-1',
        'session-1',
        undefined,
        ['assistant'],
        { page: 1, limit: 20 },
      );
    });

    it('normalizes a repeated events param into an array', async () => {
      await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/messages?events=assistant&events=result',
        headers: authHeaders,
      });
      expect(queries.listConversation).toHaveBeenCalledWith(
        'user-1',
        'session-1',
        undefined,
        ['assistant', 'result'],
        { page: 1, limit: 20 },
      );
    });

    it('normalizes a comma-separated events param into an array', async () => {
      await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/messages?events=assistant,result',
        headers: authHeaders,
      });
      expect(queries.listConversation).toHaveBeenCalledWith(
        'user-1',
        'session-1',
        undefined,
        ['assistant', 'result'],
        { page: 1, limit: 20 },
      );
    });

    it('rejects a malformed runId with the error envelope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/messages?runId=not-an-object-id',
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
      expect(queries.listConversation).not.toHaveBeenCalled();
    });

    it('404s (indistinguishably) when the session is missing or belongs to another user', async () => {
      queries.listConversation.mockResolvedValue(null);
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/someone-elses-session/messages',
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'No session "someone-elses-session" for the authenticated user',
        },
      });
    });

    it('returns 401 in the shared error envelope without a token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/messages',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    });
  });

  describe('GET /v1/sessions/:sessionId/tool-calls', () => {
    it('returns the tool-call page in the success envelope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/tool-calls',
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        data: [sampleToolCall],
        pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1 },
      });
      expect(queries.listToolCalls).toHaveBeenCalledWith(
        'user-1',
        'session-1',
        undefined,
        undefined,
        { page: 1, limit: 20 },
      );
    });

    it('passes a runId filter through to the query layer', async () => {
      const runId = 'cccccccccccccccccccccccc';
      await app.inject({
        method: 'GET',
        url: `/v1/sessions/session-1/tool-calls?runId=${runId}`,
        headers: authHeaders,
      });
      expect(queries.listToolCalls).toHaveBeenCalledWith('user-1', 'session-1', runId, undefined, {
        page: 1,
        limit: 20,
      });
    });

    it('passes a category filter through to the query layer', async () => {
      await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/tool-calls?category=git',
        headers: authHeaders,
      });
      expect(queries.listToolCalls).toHaveBeenCalledWith('user-1', 'session-1', undefined, 'git', {
        page: 1,
        limit: 20,
      });
    });

    it('rejects a malformed runId with the error envelope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/tool-calls?runId=not-an-object-id',
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
      expect(queries.listToolCalls).not.toHaveBeenCalled();
    });

    it('404s (indistinguishably) when the session is missing or belongs to another user', async () => {
      queries.listToolCalls.mockResolvedValue(null);
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/someone-elses-session/tool-calls',
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'No session "someone-elses-session" for the authenticated user',
        },
      });
    });

    it('returns 401 in the shared error envelope without a token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/session-1/tool-calls',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    });
  });

  it('answers unknown routes with the shared 404 envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nope', headers: authHeaders });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('documents all three read routes in the OpenAPI spec', async () => {
    const response = await app.inject({ method: 'GET', url: '/open/openapi.json' });
    const spec = response.json();
    expect(spec.paths['/v1/sessions'].get).toBeDefined();
    expect(spec.paths['/v1/sessions/{sessionId}/messages'].get).toBeDefined();
    expect(spec.paths['/v1/sessions/{sessionId}/tool-calls'].get).toBeDefined();
    expect(spec.paths['/v1/sessions'].get.security).toEqual([{ Bearer: [] }]);
  });
});
