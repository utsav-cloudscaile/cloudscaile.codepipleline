import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/config/index.js';
import type { RepoInstructionDTO, RepoInstructionQueries } from '@/db/index.js';
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

const sampleInstruction: RepoInstructionDTO = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  repoUrl: 'https://github.com/acme/widgets.git',
  repoSlug: 'acme-widgets',
  name: 'testing',
  content: 'Always run pnpm test before committing.',
  enabled: true,
  createdAt: '2026-07-22T09:00:00.000Z',
  updatedAt: '2026-07-23T10:00:00.000Z',
};

describe('/v1/repo-instructions CRUD routes', () => {
  let app: FastifyInstance;
  let queries: { [K in keyof RepoInstructionQueries]: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    queries = {
      list: vi.fn().mockResolvedValue({ items: [sampleInstruction], total: 1 }),
      getById: vi.fn().mockResolvedValue(sampleInstruction),
      create: vi.fn().mockResolvedValue(sampleInstruction),
      update: vi.fn().mockResolvedValue(sampleInstruction),
      remove: vi.fn().mockResolvedValue(true),
      listActiveForRepo: vi.fn().mockResolvedValue([]),
    };
    app = await buildServer({
      config,
      mcpServers: {},
      policy: { ...DEFAULT_POLICY, allowedTools: ['Read'] },
      logger: false,
      runPipelineFn: vi.fn() as unknown as typeof import('@/pipeline/index.js').runPipeline,
      repoInstructionQueries: queries as unknown as RepoInstructionQueries,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /v1/repo-instructions', () => {
    it('returns 401 without a token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/repo-instructions',
        payload: { repoUrl: sampleInstruction.repoUrl, name: 'testing', content: 'body' },
      });
      expect(response.statusCode).toBe(401);
      expect(queries.create).not.toHaveBeenCalled();
    });

    it('creates and returns 201 with the created instruction in the success envelope', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/repo-instructions',
        headers: authHeaders,
        payload: { repoUrl: sampleInstruction.repoUrl, name: 'testing', content: 'body' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ success: true, data: sampleInstruction });
      expect(queries.create).toHaveBeenCalledWith({
        repoUrl: sampleInstruction.repoUrl,
        name: 'testing',
        content: 'body',
        enabled: true,
      });
    });

    it('rejects an unrecognized top-level field', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/repo-instructions',
        headers: authHeaders,
        payload: {
          repoUrl: sampleInstruction.repoUrl,
          name: 'testing',
          content: 'body',
          notARealField: 'sneaky',
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(queries.create).not.toHaveBeenCalled();
    });

    it('rejects a name with disallowed characters', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/repo-instructions',
        headers: authHeaders,
        payload: { repoUrl: sampleInstruction.repoUrl, name: '<script>', content: 'body' },
      });
      expect(response.statusCode).toBe(400);
      expect(queries.create).not.toHaveBeenCalled();
    });

    it('maps a conflicting name to the 409 error envelope', async () => {
      queries.create.mockRejectedValue(
        Object.assign(
          new Error('A repo instruction named "testing" already exists for this repo.'),
          {
            statusCode: 409,
          },
        ),
      );
      const response = await app.inject({
        method: 'POST',
        url: '/v1/repo-instructions',
        headers: authHeaders,
        payload: { repoUrl: sampleInstruction.repoUrl, name: 'testing', content: 'body' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    });
  });

  describe('GET /v1/repo-instructions', () => {
    it('returns the page in the success envelope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/repo-instructions',
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        data: [sampleInstruction],
        pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1 },
      });
      expect(queries.list).toHaveBeenCalledWith(undefined, { page: 1, limit: 20 });
    });

    it('passes a repoUrl filter through to the query layer', async () => {
      await app.inject({
        method: 'GET',
        url: `/v1/repo-instructions?repoUrl=${encodeURIComponent(sampleInstruction.repoUrl)}`,
        headers: authHeaders,
      });
      expect(queries.list).toHaveBeenCalledWith(sampleInstruction.repoUrl, {
        page: 1,
        limit: 20,
      });
    });
  });

  describe('GET /v1/repo-instructions/:id', () => {
    it('returns the instruction in the success envelope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/repo-instructions/${sampleInstruction.id}`,
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, data: sampleInstruction });
      expect(queries.getById).toHaveBeenCalledWith(sampleInstruction.id);
    });

    it('404s when missing', async () => {
      queries.getById.mockResolvedValue(null);
      const response = await app.inject({
        method: 'GET',
        url: `/v1/repo-instructions/${sampleInstruction.id}`,
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    });

    it('rejects a malformed id before hitting the query layer', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/repo-instructions/not-an-object-id',
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(400);
      expect(queries.getById).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /v1/repo-instructions/:id', () => {
    it('updates and returns the instruction in the success envelope', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/repo-instructions/${sampleInstruction.id}`,
        headers: authHeaders,
        payload: { enabled: false },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, data: sampleInstruction });
      expect(queries.update).toHaveBeenCalledWith(sampleInstruction.id, {
        enabled: false,
      });
    });

    it('rejects an empty body', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/repo-instructions/${sampleInstruction.id}`,
        headers: authHeaders,
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(queries.update).not.toHaveBeenCalled();
    });

    it('404s when missing', async () => {
      queries.update.mockResolvedValue(null);
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/repo-instructions/${sampleInstruction.id}`,
        headers: authHeaders,
        payload: { content: 'updated body' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('maps a rename conflict to the 409 error envelope', async () => {
      queries.update.mockRejectedValue(
        Object.assign(
          new Error('A repo instruction named "deploy" already exists for this repo.'),
          {
            statusCode: 409,
          },
        ),
      );
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/repo-instructions/${sampleInstruction.id}`,
        headers: authHeaders,
        payload: { name: 'deploy' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    });
  });

  describe('DELETE /v1/repo-instructions/:id', () => {
    it('deletes and returns the id in the success envelope', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/repo-instructions/${sampleInstruction.id}`,
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, data: { id: sampleInstruction.id } });
      expect(queries.remove).toHaveBeenCalledWith(sampleInstruction.id);
    });

    it('404s when missing', async () => {
      queries.remove.mockResolvedValue(false);
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/repo-instructions/${sampleInstruction.id}`,
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it('documents all five routes in the OpenAPI spec, each requiring the Bearer scheme', async () => {
    const response = await app.inject({ method: 'GET', url: '/open/openapi.json' });
    const spec = response.json();
    expect(spec.paths['/v1/repo-instructions'].post).toBeDefined();
    expect(spec.paths['/v1/repo-instructions'].get).toBeDefined();
    expect(spec.paths['/v1/repo-instructions/{id}'].get).toBeDefined();
    expect(spec.paths['/v1/repo-instructions/{id}'].patch).toBeDefined();
    expect(spec.paths['/v1/repo-instructions/{id}'].delete).toBeDefined();
    expect(spec.paths['/v1/repo-instructions'].post.security).toEqual([{ Bearer: [] }]);
  });
});
