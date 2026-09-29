import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/config/index.js';
import type { RepoInstructionQueries, UsageQueries } from '@/db/index.js';
import { DEFAULT_POLICY } from '@/guardrails/index.js';
import { WORKSPACE_ROOT, workspaceDir } from '@/mcp/git/workspace.js';
import type { PipelineOptions, PipelineResult } from '@/pipeline/index.js';
import { buildServer } from '@/server/index.js';

const config: AppConfig = {
  policyPath: './pipeline.policy.json',
  policy: {},
  logLevel: 'error',
  model: 'claude-haiku-4-5-20251001',
  git: { token: 'test-token', email: 'bot@example.com', name: 'Pipeline Bot' },
  trigger: { port: 0, host: '127.0.0.1' },
  // No max set — usage limiting off by default, so no test here needs a DB.
  usageLimits: { windowHours: 24 },
  // Never connected in tests — createRunRecorder no-ops when mongoose is disconnected.
  mongo: { uri: 'mongodb://localhost:27017/code-pipeline-test', autoMigrate: false },
};

const policy = { ...DEFAULT_POLICY, allowedTools: ['Read'] };

/** repoUrl is required now — a stand-in for tests that don't care about its specific value. */
const testRepoUrl = 'https://github.com/Cloudscaile-Experience/test-code-pipeline.git';

/** Unique per test so workspace state left behind by other tests can't interfere. */
function uniqueRepoUrl(name: string): string {
  return `https://github.com/acme/${name}.git`;
}

/** Builds an unsigned JWT — this service only ever decodes the payload, never the signature. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

/** Stands in for the JWT the API gateway would forward on a real request. */
const validToken = makeJwt({ sub: 'user-1', email: 'user@example.com' });
const authHeaders = { authorization: `Bearer ${validToken}` };

/** POSTs to /trigger with a valid Authorization header, the way the gateway would send it. */
async function injectTrigger(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/trigger', payload, headers: authHeaders });
}

async function cleanWorkspace(repoUrl: string): Promise<void> {
  await rm(workspaceDir(WORKSPACE_ROOT, repoUrl), { recursive: true, force: true });
}

/** Splits an SSE response body into its `{ event, data }` frames. */
function parseSseEvents(payload: string): Array<{ event: string; data: unknown }> {
  return payload
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? '';
      const dataLine = lines.find((line) => line.startsWith('data: '));
      return { event, data: dataLine ? JSON.parse(dataLine.slice('data: '.length)) : undefined };
    });
}

describe('POST /trigger', () => {
  let app: FastifyInstance;
  let runPipelineFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    runPipelineFn = vi
      .fn<(options: PipelineOptions) => Promise<PipelineResult>>()
      .mockResolvedValue([
        {
          stage: 'trigger',
          ok: true,
          numTurns: 1,
          totalCostUsd: 0.01,
          summary: 'done',
          errors: [],
          sessionId: 'session-1',
        },
      ]);
    app = await buildServer({
      config,
      mcpServers: {},
      policy,
      logger: false,
      runPipelineFn: runPipelineFn as unknown as typeof import('@/pipeline/index.js').runPipeline,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 400 when prompt is missing', async () => {
    const response = await injectTrigger(app, {});
    expect(response.statusCode).toBe(400);
    expect(runPipelineFn).not.toHaveBeenCalled();
  });

  it('returns 400 when repoUrl is missing', async () => {
    const response = await injectTrigger(app, { prompt: 'do the thing' });
    expect(response.statusCode).toBe(400);
    expect(runPipelineFn).not.toHaveBeenCalled();
  });

  it('returns 400 when repoUrl is not a valid URL', async () => {
    const response = await injectTrigger(app, { prompt: 'do the thing', repoUrl: 'not-a-url' });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when sessionId is not a valid UUID', async () => {
    const response = await injectTrigger(app, {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
      sessionId: 'not-a-uuid',
    });
    expect(response.statusCode).toBe(400);
    expect(runPipelineFn).not.toHaveBeenCalled();
  });

  it('returns 400 in the error envelope and never runs the pipeline when the body has an unrecognized top-level key', async () => {
    const response = await injectTrigger(app, {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
      notARealField: 'sneaky',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(runPipelineFn).not.toHaveBeenCalled();
  });

  it('returns 400 and never runs the pipeline when a refDirs entry has an unrecognized key', async () => {
    const response = await injectTrigger(app, {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
      refDirs: [{ path: 'packages/shared', notARealField: 'sneaky' }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(runPipelineFn).not.toHaveBeenCalled();
  });

  it('streams an SSE response and ends with a `done` event containing the summary and sessionId', async () => {
    const response = await injectTrigger(app, { prompt: 'do the thing', repoUrl: testRepoUrl });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const events = parseSseEvents(response.payload);
    const done = events.at(-1);
    expect(done).toMatchObject({
      event: 'done',
      data: {
        ok: true,
        repoUrl: testRepoUrl,
        slug: 'cloudscaile-experience-test-code-pipeline',
        sessionId: 'session-1',
      },
    });
  });

  it('forwards every SDK message onMessage emits as its own SSE event, before the final done event', async () => {
    runPipelineFn.mockImplementation(async (opts: PipelineOptions) => {
      opts.onMessage?.('trigger', {
        type: 'system',
        subtype: 'init',
        session_id: 'session-1',
      } as never);
      opts.onMessage?.('trigger', { type: 'assistant', session_id: 'session-1' } as never);
      return [
        {
          stage: 'trigger',
          ok: true,
          numTurns: 1,
          totalCostUsd: 0.01,
          summary: 'done',
          errors: [],
          sessionId: 'session-1',
        },
      ];
    });

    const response = await injectTrigger(app, { prompt: 'do the thing', repoUrl: testRepoUrl });

    const events = parseSseEvents(response.payload);
    expect(events.map((e) => e.event)).toEqual(['system', 'assistant', 'done']);
  });

  it('redacts the git token from every streamed event', async () => {
    runPipelineFn.mockImplementation(async (opts: PipelineOptions) => {
      opts.onMessage?.('trigger', {
        type: 'assistant',
        session_id: 'session-1',
        note: 'cloning https://test-token@github.com/acme/widgets.git',
      } as never);
      return [
        {
          stage: 'trigger',
          ok: true,
          numTurns: 1,
          totalCostUsd: 0.01,
          summary: 'cloned via https://test-token@github.com/acme/widgets.git',
          errors: [],
          sessionId: 'session-1',
        },
      ];
    });

    const response = await injectTrigger(app, { prompt: 'do the thing', repoUrl: testRepoUrl });

    expect(response.payload).not.toContain('test-token');
    expect(response.payload).toContain('[REDACTED]');
  });

  it('runs the pipeline with a stage prompt containing the caller task and cwd, with no resume set', async () => {
    const response = await injectTrigger(app, {
      prompt: 'add a health check route',
      repoUrl: 'https://github.com/acme/widgets.git',
    });

    expect(response.statusCode).toBe(200);
    expect(runPipelineFn).toHaveBeenCalledTimes(1);
    const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
    expect(options.stages).toHaveLength(1);
    expect(options.stages[0]?.prompt).toContain('add a health check route');
    expect(options.stages[0]?.cwd).toContain('acme-widgets');
    expect(options.stages[0]?.resume).toBeUndefined();
    expect(options.policy).toBe(policy);
    expect(options.model).toBe(config.model);
  });

  it('passes sessionId through as the stage resume option', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const response = await injectTrigger(app, {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
      sessionId,
    });

    expect(response.statusCode).toBe(200);
    const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
    expect(options.stages[0]?.resume).toBe(sessionId);
  });

  it('emits a done event with ok: false when a pipeline stage fails', async () => {
    runPipelineFn.mockResolvedValue([
      {
        stage: 'trigger',
        ok: false,
        numTurns: 5,
        totalCostUsd: 0.2,
        summary: 'failed',
        errors: ['boom'],
        sessionId: 'session-1',
      },
    ]);
    const response = await injectTrigger(app, { prompt: 'do the thing', repoUrl: testRepoUrl });
    expect(response.statusCode).toBe(200);
    const done = parseSseEvents(response.payload).at(-1);
    expect(done).toMatchObject({ event: 'done', data: { ok: false } });
  });

  it('emits an error event when runPipeline throws', async () => {
    runPipelineFn.mockRejectedValue(new Error('spawn failed'));
    const response = await injectTrigger(app, { prompt: 'do the thing', repoUrl: testRepoUrl });
    expect(response.statusCode).toBe(200);
    const event = parseSseEvents(response.payload).at(-1);
    expect(event).toBeDefined();
    expect(event?.event).toBe('error');
    const data = event?.data as { error: string };
    expect(data.error).toContain('spawn failed');
  });

  describe('dir', () => {
    it('returns 400 and never runs the pipeline when dir is an absolute path', async () => {
      const repoUrl = uniqueRepoUrl('dir-absolute');
      const response = await injectTrigger(app, { prompt: 'do the thing', repoUrl, dir: '/etc' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('relative path') },
      });
      expect(runPipelineFn).not.toHaveBeenCalled();
      await cleanWorkspace(repoUrl);
    });

    it('returns 400 and never runs the pipeline when dir escapes the repo via ..', async () => {
      const repoUrl = uniqueRepoUrl('dir-escape');
      const response = await injectTrigger(app, {
        prompt: 'do the thing',
        repoUrl,
        dir: '../../etc',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('inside the repo') },
      });
      expect(runPipelineFn).not.toHaveBeenCalled();
      await cleanWorkspace(repoUrl);
    });

    it('runs the pipeline (does not 400) when dir is given but the repo has not been cloned yet, deferring the check to the stage prompt', async () => {
      const repoUrl = uniqueRepoUrl('dir-not-cloned');
      const cwd = workspaceDir(WORKSPACE_ROOT, repoUrl);
      await cleanWorkspace(repoUrl); // guarantee no leftover .git from a previous run

      const response = await injectTrigger(app, {
        prompt: 'do the thing',
        repoUrl,
        dir: 'packages/api',
      });

      expect(response.statusCode).toBe(200);
      expect(runPipelineFn).toHaveBeenCalledTimes(1);
      const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
      // The subdirectory doesn't exist on disk yet (nothing's cloned), so the
      // stage spawns at the repo root, not the not-yet-existing subdirectory.
      expect(options.stages[0]?.cwd).toBe(cwd);
      expect(options.stages[0]?.prompt).toContain(path.join(cwd, 'packages', 'api'));
      expect(options.stages[0]?.prompt).toContain('verify that');
      expect(options.stages[0]?.prompt).toContain('stop immediately');
      await cleanWorkspace(repoUrl);
    });

    it('returns 400 when dir does not exist inside an already-cloned repo', async () => {
      const repoUrl = uniqueRepoUrl('dir-missing-subdir');
      const cwd = workspaceDir(WORKSPACE_ROOT, repoUrl);
      await mkdir(path.join(cwd, '.git'), { recursive: true });

      const response = await injectTrigger(app, {
        prompt: 'do the thing',
        repoUrl,
        dir: 'packages/does-not-exist',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('dir not found in repo') },
      });
      expect(runPipelineFn).not.toHaveBeenCalled();
      await cleanWorkspace(repoUrl);
    });

    it('scopes the stage cwd to dir when it exists inside an already-cloned repo', async () => {
      const repoUrl = uniqueRepoUrl('dir-scoped');
      const cwd = workspaceDir(WORKSPACE_ROOT, repoUrl);
      const subDir = path.join(cwd, 'packages', 'api');
      await mkdir(path.join(cwd, '.git'), { recursive: true });
      await mkdir(subDir, { recursive: true });

      const response = await injectTrigger(app, {
        prompt: 'add a health check route',
        repoUrl,
        dir: 'packages/api',
      });

      expect(response.statusCode).toBe(200);
      expect(runPipelineFn).toHaveBeenCalledTimes(1);
      const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
      expect(options.stages[0]?.cwd).toBe(subDir);
      expect(options.stages[0]?.prompt).toContain(`working inside "${subDir}"`);
      // git_pull still targets the repo root, not the subdirectory.
      expect(options.stages[0]?.prompt).toContain(`already cloned at "${cwd}"`);
      await cleanWorkspace(repoUrl);
    });
  });

  describe('refDirs', () => {
    it('returns 400 and never runs the pipeline when a refDirs entry is an absolute path', async () => {
      const repoUrl = uniqueRepoUrl('refdirs-absolute');
      const response = await injectTrigger(app, {
        prompt: 'do the thing',
        repoUrl,
        refDirs: [{ path: '/etc' }],
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('refDirs entry must be a relative path') },
      });
      expect(runPipelineFn).not.toHaveBeenCalled();
      await cleanWorkspace(repoUrl);
    });

    it('returns 400 and never runs the pipeline when a refDirs entry escapes the repo via ..', async () => {
      const repoUrl = uniqueRepoUrl('refdirs-escape');
      const response = await injectTrigger(app, {
        prompt: 'do the thing',
        repoUrl,
        refDirs: [{ path: '../../etc' }],
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('refDirs entry must resolve inside the repo') },
      });
      expect(runPipelineFn).not.toHaveBeenCalled();
      await cleanWorkspace(repoUrl);
    });

    it('returns 400 when a refDirs entry does not exist inside an already-cloned repo', async () => {
      const repoUrl = uniqueRepoUrl('refdirs-missing');
      const cwd = workspaceDir(WORKSPACE_ROOT, repoUrl);
      await mkdir(path.join(cwd, '.git'), { recursive: true });

      const response = await injectTrigger(app, {
        prompt: 'do the thing',
        repoUrl,
        refDirs: [{ path: 'packages/does-not-exist' }],
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('refDirs entry not found in repo') },
      });
      expect(runPipelineFn).not.toHaveBeenCalled();
      await cleanWorkspace(repoUrl);
    });

    it('runs the pipeline (does not 400) when refDirs is given but the repo has not been cloned yet, deferring the check to the stage prompt', async () => {
      const repoUrl = uniqueRepoUrl('refdirs-not-cloned');
      const cwd = workspaceDir(WORKSPACE_ROOT, repoUrl);
      await cleanWorkspace(repoUrl); // guarantee no leftover .git from a previous run

      const response = await injectTrigger(app, {
        prompt: 'do the thing',
        repoUrl,
        refDirs: [{ path: 'packages/shared' }],
      });

      expect(response.statusCode).toBe(200);
      expect(runPipelineFn).toHaveBeenCalledTimes(1);
      const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
      const expectedRefDir = path.join(cwd, 'packages', 'shared');
      expect(options.stages[0]?.additionalDirectories).toEqual([expectedRefDir]);
      expect(options.stages[0]?.prompt).toContain('verify that');
      expect(options.stages[0]?.prompt).toContain(expectedRefDir);
      expect(options.stages[0]?.prompt).toContain('stop immediately');
      await cleanWorkspace(repoUrl);
    });

    it('passes resolved refDirs through as additionalDirectories and mentions them in the prompt', async () => {
      const repoUrl = uniqueRepoUrl('refdirs-scoped');
      const cwd = workspaceDir(WORKSPACE_ROOT, repoUrl);
      const sharedDir = path.join(cwd, 'packages', 'shared');
      await mkdir(path.join(cwd, '.git'), { recursive: true });
      await mkdir(sharedDir, { recursive: true });

      const response = await injectTrigger(app, {
        prompt: 'add a health check route',
        repoUrl,
        refDirs: [{ path: 'packages/shared' }],
      });

      expect(response.statusCode).toBe(200);
      expect(runPipelineFn).toHaveBeenCalledTimes(1);
      const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
      expect(options.stages[0]?.additionalDirectories).toEqual([sharedDir]);
      expect(options.stages[0]?.prompt).toContain(sharedDir);
      await cleanWorkspace(repoUrl);
    });

    it('does not set additionalDirectories when refDirs is omitted', async () => {
      const response = await injectTrigger(app, { prompt: 'do the thing', repoUrl: testRepoUrl });

      expect(response.statusCode).toBe(200);
      const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
      expect(options.stages[0]?.additionalDirectories).toBeUndefined();
    });
  });

  describe('auth', () => {
    it('returns 401 and never runs the pipeline when the Authorization header is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/trigger',
        payload: { prompt: 'do the thing', repoUrl: testRepoUrl },
      });
      expect(response.statusCode).toBe(401);
      expect(runPipelineFn).not.toHaveBeenCalled();
    });

    it('returns 401 when the Authorization header is not a Bearer token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/trigger',
        payload: { prompt: 'do the thing', repoUrl: testRepoUrl },
        headers: { authorization: `Basic ${validToken}` },
      });
      expect(response.statusCode).toBe(401);
      expect(runPipelineFn).not.toHaveBeenCalled();
    });

    it('returns 401 when the JWT is malformed', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/trigger',
        payload: { prompt: 'do the thing', repoUrl: testRepoUrl },
        headers: { authorization: 'Bearer not-a-jwt' },
      });
      expect(response.statusCode).toBe(401);
      expect(runPipelineFn).not.toHaveBeenCalled();
    });

    it('does not verify the signature — a valid-shaped JWT with a bogus signature is accepted', async () => {
      // This service trusts the gateway to have already verified the signature (see CLAUDE.md);
      // it only decodes the payload. A garbage signature segment is therefore not rejected here.
      const response = await injectTrigger(app, { prompt: 'do the thing', repoUrl: testRepoUrl });
      expect(response.statusCode).toBe(200);
      expect(runPipelineFn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('POST /trigger usage limits', () => {
  let app: FastifyInstance | undefined;
  let runPipelineFn: ReturnType<typeof vi.fn>;
  let usageSince: ReturnType<typeof vi.fn<UsageQueries['usageSince']>>;

  beforeEach(() => {
    runPipelineFn = vi.fn().mockResolvedValue([
      {
        stage: 'trigger',
        ok: true,
        numTurns: 1,
        totalCostUsd: 0.01,
        summary: 'done',
        errors: [],
        sessionId: 'session-1',
      },
    ]);
    usageSince = vi.fn().mockResolvedValue({ costUsd: 0, tokens: 0, runs: 0 });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function buildWithLimits(usageLimits: AppConfig['usageLimits']): Promise<FastifyInstance> {
    app = await buildServer({
      config: { ...config, usageLimits },
      mcpServers: {},
      policy,
      logger: false,
      runPipelineFn: runPipelineFn as unknown as typeof import('@/pipeline/index.js').runPipeline,
      usageQueries: { usageSince },
    });
    return app;
  }

  it('never queries usage when no limit is configured', async () => {
    const response = await injectTrigger(await buildWithLimits({ windowHours: 24 }), {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
    });

    expect(response.statusCode).toBe(200);
    expect(usageSince).not.toHaveBeenCalled();
    expect(runPipelineFn).toHaveBeenCalledTimes(1);
  });

  it('queries the caller`s usage over the configured window and runs when under the limit', async () => {
    usageSince.mockResolvedValue({ costUsd: 1, tokens: 10, runs: 1 });
    const before = Date.now();
    const response = await injectTrigger(await buildWithLimits({ windowHours: 1, maxRuns: 10 }), {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
    });

    expect(response.statusCode).toBe(200);
    expect(runPipelineFn).toHaveBeenCalledTimes(1);
    expect(usageSince).toHaveBeenCalledTimes(1);
    const [userId, since] = usageSince.mock.calls[0] as [string, Date];
    expect(userId).toBe('user-1'); // the JWT sub, not email
    // `since` is one windowHour before the request (which happened between `before` and now).
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(before - since.getTime()).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('returns a 429 envelope and never runs the pipeline when the cost limit is reached', async () => {
    usageSince.mockResolvedValue({ costUsd: 5, tokens: 10, runs: 1 });
    const response = await injectTrigger(
      await buildWithLimits({ windowHours: 24, maxCostUsd: 5 }),
      {
        prompt: 'do the thing',
        repoUrl: testRepoUrl,
      },
    );

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'USAGE_LIMIT_EXCEEDED', message: expect.stringContaining('$5') },
    });
    expect(runPipelineFn).not.toHaveBeenCalled();
  });

  it('returns 429 when the run-count limit is reached', async () => {
    usageSince.mockResolvedValue({ costUsd: 0, tokens: 0, runs: 10 });
    const response = await injectTrigger(await buildWithLimits({ windowHours: 24, maxRuns: 10 }), {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: 'USAGE_LIMIT_EXCEEDED' } });
    expect(runPipelineFn).not.toHaveBeenCalled();
  });

  it('returns 429 when the token limit is reached', async () => {
    usageSince.mockResolvedValue({ costUsd: 0, tokens: 200_000, runs: 0 });
    const response = await injectTrigger(
      await buildWithLimits({ windowHours: 24, maxTokens: 100_000 }),
      { prompt: 'do the thing', repoUrl: testRepoUrl },
    );

    expect(response.statusCode).toBe(429);
    expect(runPipelineFn).not.toHaveBeenCalled();
  });

  it('fails closed with a 503 envelope when limits are configured but the usage store is down', async () => {
    // Same error shape usageQueries.usageSince throws via requireConnected (src/db/usage.ts).
    usageSince.mockRejectedValue(
      Object.assign(new Error('Persistence store is unavailable'), { statusCode: 503 }),
    );
    const response = await injectTrigger(await buildWithLimits({ windowHours: 24, maxRuns: 10 }), {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Persistence store is unavailable' },
    });
    expect(runPipelineFn).not.toHaveBeenCalled();
  });
});

describe('POST /trigger repo instructions', () => {
  let app: FastifyInstance | undefined;
  let runPipelineFn: ReturnType<typeof vi.fn>;
  let listActiveForRepo: ReturnType<typeof vi.fn<RepoInstructionQueries['listActiveForRepo']>>;

  beforeEach(() => {
    runPipelineFn = vi.fn().mockResolvedValue([
      {
        stage: 'trigger',
        ok: true,
        numTurns: 1,
        totalCostUsd: 0.01,
        summary: 'done',
        errors: [],
        sessionId: 'session-1',
      },
    ]);
    listActiveForRepo = vi.fn().mockResolvedValue([]);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function buildWithRepoInstructions(): Promise<FastifyInstance> {
    app = await buildServer({
      config,
      mcpServers: {},
      policy,
      logger: false,
      runPipelineFn: runPipelineFn as unknown as typeof import('@/pipeline/index.js').runPipeline,
      repoInstructionQueries: {
        list: vi.fn(),
        getById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        listActiveForRepo,
      },
    });
    return app;
  }

  it('does not set stage.additionalContext when there are no enabled instructions for the repo', async () => {
    const response = await injectTrigger(await buildWithRepoInstructions(), {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
    });

    expect(response.statusCode).toBe(200);
    expect(listActiveForRepo).toHaveBeenCalledWith(testRepoUrl);
    const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
    expect(options.stages[0]?.additionalContext).toBeUndefined();
  });

  it('formats enabled instructions as XML and passes them as stage.additionalContext', async () => {
    listActiveForRepo.mockResolvedValue([{ name: 'testing', content: 'Run pnpm test first.' }]);

    const response = await injectTrigger(await buildWithRepoInstructions(), {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
    });

    expect(response.statusCode).toBe(200);
    const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
    const additionalContext = options.stages[0]?.additionalContext;
    expect(additionalContext).toContain(`<repository_instructions repo="${testRepoUrl}">`);
    expect(additionalContext).toContain('<instruction name="testing">');
    expect(additionalContext).toContain('Run pnpm test first.');
  });

  it('runs the pipeline without additionalContext when the repo-instructions lookup fails (best-effort, unlike usage limits)', async () => {
    listActiveForRepo.mockRejectedValue(
      Object.assign(new Error('Persistence store is unavailable'), { statusCode: 503 }),
    );

    const response = await injectTrigger(await buildWithRepoInstructions(), {
      prompt: 'do the thing',
      repoUrl: testRepoUrl,
    });

    expect(response.statusCode).toBe(200);
    expect(runPipelineFn).toHaveBeenCalledTimes(1);
    const [options] = runPipelineFn.mock.calls[0] as [PipelineOptions];
    expect(options.stages[0]?.additionalContext).toBeUndefined();
  });
});

describe('GET /docs', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({
      config,
      mcpServers: {},
      policy,
      logger: false,
      runPipelineFn: vi.fn() as unknown as typeof import('@/pipeline/index.js').runPipeline,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the Swagger UI at /open/docs', async () => {
    const response = await app.inject({ method: 'GET', url: '/open/docs' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('serves the generated OpenAPI document at /open/openapi.json, describing POST /trigger', async () => {
    const response = await app.inject({ method: 'GET', url: '/open/openapi.json' });
    expect(response.statusCode).toBe(200);
    const spec = response.json();
    expect(spec.paths['/v1/trigger']).toBeDefined();
    expect(spec.paths['/v1/trigger'].post).toBeDefined();
  });

  it('marks /trigger as requiring the Bearer scheme in the OpenAPI doc', async () => {
    const response = await app.inject({ method: 'GET', url: '/open/openapi.json' });
    const spec = response.json();
    expect(spec.components.securitySchemes.Bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(spec.paths['/v1/trigger'].post.security).toEqual([{ Bearer: [] }]);
  });
});
