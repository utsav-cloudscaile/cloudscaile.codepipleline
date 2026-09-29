/**
 * POST /v1/trigger — kicks off a pipeline run against a target repo and
 * streams progress back as Server-Sent Events.
 *
 * The response is an SSE stream, not a JSON body: a pipeline run can take
 * minutes, and a plain request/response gives the caller nothing to look at
 * in the meantime. Every SDK message (assistant text, tool calls, tool
 * results, the final result message, ...) is forwarded as its own event,
 * named after `message.type`, as soon as the pipeline emits it. A final
 * `done` (or `error`) event carries the run summary plus `sessionId` — pass
 * that back as `sessionId` in a later request to resume this exact
 * conversation (via the Agent SDK's `resume` option, see
 * src/pipeline/index.ts).
 *
 * Note the streamed frames are NOT wrapped in the /v1 success envelope
 * (src/server/schemas/common.ts): the frame format is the persisted replay
 * format (src/db) and pre-dates the envelope. Only this route's pre-stream
 * failures (validation 400s) use the envelope, like every other route.
 *
 * The whole run is also persisted to MongoDB via createRunRecorder (src/db)
 * under the caller's userId + the Agent SDK sessionId — the same identifiers
 * the /v1/sessions read routes query by.
 *
 * Before the stage prompt is built, this route also fetches `repoUrl`'s
 * enabled instruction blocks (src/db/repoInstructions.ts, managed via the
 * /v1/repo-instructions CRUD API — associated with the repo only, not the
 * caller) and layers them into the stage's system prompt, XML-tagged and
 * separate from the repo-agnostic master context (see formatRepoInstructions,
 * src/pipeline/repoInstructions.ts). That lookup is best-effort: unlike the
 * usage-limit gate above, a failure here costs this run's personalization,
 * not the run itself.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { callerIdentity } from '@/auth/index.js';
import type { AppConfig } from '@/config/index.js';
import {
  createRunRecorder,
  evaluateUsageLimits,
  type RepoInstructionQueries,
  type UsageQueries,
  usageLimitsActive,
} from '@/db/index.js';
import type { PolicyConfig } from '@/guardrails/index.js';
import { repoSlug, WORKSPACE_ROOT, withTokenAuth, workspaceDir } from '@/mcp/git/workspace.js';
import type { McpServerRegistry } from '@/mcp/index.js';
import { formatRepoInstructions, type runPipeline } from '@/pipeline/index.js';
import { errorBody, errorResponseSchema, type FastifyZodInstance } from '../../schemas/common.js';
import { triggerBodySchema } from '../../schemas/trigger.js';

export interface TriggerRouteOptions {
  config: AppConfig;
  mcpServers: McpServerRegistry;
  policy: PolicyConfig;
  run: typeof runPipeline;
  /** Window aggregate over the usage ledger for the usage-limit check (src/db/usage.ts). */
  usage: UsageQueries;
  /** Enabled per-repo instructions (src/db/repoInstructions.ts) layered into the stage's system prompt. */
  repoInstructions: RepoInstructionQueries;
}

/**
 * Builds the stage prompt: sync instructions (clone vs. pull) + an optional post-clone
 * `dir`/`refDirs` check + the caller's task + a commit/push instruction. `repoDir` is
 * always the repo root — git operations (clone, pull, add, commit, push) target it
 * explicitly regardless of `dir` — while `workDir` is where the agent's own file edits
 * happen, narrowed to the caller's `dir` when given. `refDirs` are extra directories the
 * agent can read/write (via the SDK's `additionalDirectories`, see resolveRefDirs) but
 * isn't otherwise scoped to.
 */
function buildStagePrompt(params: {
  repoDir: string;
  workDir: string;
  refDirs: string[];
  verifyAfterClone: boolean;
  repoUrl: string;
  token: string;
  task: string;
}): string {
  const alreadyCloned = existsSync(path.join(params.repoDir, '.git'));
  const syncStep = alreadyCloned
    ? `This repo is already cloned at "${params.repoDir}". Run git_pull there first (path: "${params.repoDir}") to bring it up to date.`
    : `Clone "${withTokenAuth(params.repoUrl, params.token)}" into "${params.repoDir}" first, using git_clone ` +
      `(url: that URL, path: "${params.repoDir}"). That URL contains a credential — never print, log, or commit it.`;

  // Only needed when `dir`/`refDirs` couldn't be checked against disk up front (see
  // resolveWorkDir/resolveRefDirs): the repo wasn't cloned locally yet, so this is the
  // first chance to confirm the requested directories actually exist.
  const verifyStep = params.verifyAfterClone
    ? [
        '',
        `Before making any changes, verify that "${params.workDir}"` +
          (params.refDirs.length > 0
            ? ` and each of these extra directories exist in the repo you just cloned: ${params.refDirs.map((d) => `"${d}"`).join(', ')}.`
            : ' exists in the repo you just cloned.') +
          ' If any of them do not exist, stop immediately, make no changes, and report which directory was not found.',
      ]
    : [];

  const refDirsStep =
    params.refDirs.length > 0
      ? [
          '',
          `You also have read/write access to these extra directories beyond "${params.workDir}", ` +
            `should the task need them: ${params.refDirs.map((d) => `"${d}"`).join(', ')}.`,
        ]
      : [];

  return [
    syncStep,
    ...verifyStep,
    ...refDirsStep,
    '',
    `Then, working inside "${params.workDir}", make the following change:`,
    params.task,
    '',
    'When finished: stage your changes (git_add), commit them (git_commit) with a clear message, ' +
      'and push (git_push) to the branch the workspace is already on.',
  ].join('\n');
}

/**
 * Resolves `relPath` (relative to the repo root `repoDir`) into an absolute path, or an
 * error. Returns an error message instead of throwing — the caller decides how to respond
 * (a plain 400, not an SSE event, since this check runs before the pipeline starts).
 *
 * `relPath` can only be checked against the filesystem when the repo is already cloned
 * locally (`alreadyCloned`) — on a repo's first-ever trigger there's nothing on disk yet
 * to check against (and nothing else clones it: see CLAUDE.md on why cloning happens
 * through the agent's own git_clone MCP call, not here). In that case
 * `verifyAfterClone: true` defers the check to the stage prompt instead of failing a
 * request that might be perfectly valid.
 */
function resolveRepoPath(
  repoDir: string,
  relPath: string,
  alreadyCloned: boolean,
): { path: string; verifyAfterClone: boolean } | { error: string } {
  if (path.isAbsolute(relPath)) {
    return { error: `must be a relative path, got: "${relPath}"` };
  }
  const resolved = path.resolve(repoDir, relPath);
  if (resolved !== repoDir && !resolved.startsWith(repoDir + path.sep)) {
    return { error: `must resolve inside the repo, got: "${relPath}"` };
  }
  if (!alreadyCloned) {
    return { path: resolved, verifyAfterClone: true };
  }
  if (!existsSync(resolved)) {
    return { error: `not found in repo: "${relPath}"` };
  }
  return { path: resolved, verifyAfterClone: false };
}

/** Resolves the caller's `dir` into the absolute directory the agent should be scoped to. */
function resolveWorkDir(
  repoDir: string,
  dir: string | undefined,
  alreadyCloned: boolean,
): { workDir: string; verifyAfterClone: boolean } | { error: string } {
  if (dir === undefined) {
    return { workDir: repoDir, verifyAfterClone: false };
  }
  const result = resolveRepoPath(repoDir, dir, alreadyCloned);
  if ('error' in result) {
    return { error: `dir ${result.error}` };
  }
  return { workDir: result.path, verifyAfterClone: result.verifyAfterClone };
}

/** Resolves the caller's `refDirs` into absolute paths for the SDK's `additionalDirectories`. */
function resolveRefDirs(
  repoDir: string,
  refDirs: Array<{ path: string }> | undefined,
  alreadyCloned: boolean,
): { refDirs: string[]; verifyAfterClone: boolean } | { error: string } {
  const resolved: string[] = [];
  let verifyAfterClone = false;
  for (const { path: relPath } of refDirs ?? []) {
    const result = resolveRepoPath(repoDir, relPath, alreadyCloned);
    if ('error' in result) {
      return { error: `refDirs entry ${result.error}` };
    }
    resolved.push(result.path);
    verifyAfterClone ||= result.verifyAfterClone;
  }
  return { refDirs: resolved, verifyAfterClone };
}

/**
 * Removes every occurrence of `secret` from `text`. Used before writing any
 * SSE event: the stage prompt embeds an authenticated clone URL
 * (`withTokenAuth`), and the Agent SDK echoes prompts/tool-inputs back
 * verbatim in `user`/`assistant` messages — without this, streaming the raw
 * message feed to the caller would leak the git token that
 * `buildStagePrompt` was careful never to have the model print or commit.
 */
function redactSecret(secret: string, text: string): string {
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

export function registerTriggerRoute(app: FastifyZodInstance, options: TriggerRouteOptions): void {
  app.post(
    '/trigger',
    {
      schema: {
        description:
          'Clones/pulls repoUrl, runs the pipeline against it with prompt, then commits and pushes ' +
          'the result. Responds with a Server-Sent Events stream: one event per SDK message while ' +
          'the pipeline runs, then a final `done` event with the summary and a `sessionId` ' +
          '(pass it back as `sessionId` to resume this conversation).',
        tags: ['pipeline'],
        body: triggerBodySchema,
        response: { 400: errorResponseSchema, 429: errorResponseSchema },
      },
      onRequest: app.authenticate,
    },
    async (request, reply) => {
      const { prompt, repoUrl, sessionId, dir, refDirs } = request.body;
      request.log.info({ user: request.user }, 'trigger invoked');
      const { userId, userEmail } = callerIdentity(request.user);

      // Usage-limit gate — before any workspace side effect or the SSE
      // stream starts, so a capped caller gets a plain 429 envelope. Skipped
      // entirely (no DB query) when no limit is configured; fails closed with
      // a 503 when limits are configured but MongoDB is down (src/db/usage.ts).
      const limits = options.config.usageLimits;
      if (usageLimitsActive(limits)) {
        const since = new Date(Date.now() - limits.windowHours * 60 * 60 * 1000);
        const verdict = evaluateUsageLimits(limits, await options.usage.usageSince(userId, since));
        if (verdict.exceeded) {
          request.log.warn({ userId, limit: verdict.limit }, 'trigger denied by usage limit');
          return reply.code(429).send(errorBody('USAGE_LIMIT_EXCEEDED', verdict.message));
        }
      }

      const cwd = workspaceDir(WORKSPACE_ROOT, repoUrl);
      // The Agent SDK spawns its subprocess with this as its cwd — it must
      // exist before query() is called, even on a fresh (not-yet-cloned)
      // repo, or the spawn fails with ENOENT (surfaced as a confusing
      // "binary failed to launch" error, not an obviously-missing-directory
      // one).
      await mkdir(cwd, { recursive: true });

      // A plain 400, not an SSE event: this is a request-validation failure
      // (bad or missing `dir`/`refDirs`), same tier as the zod checks above,
      // and it's known before the pipeline — and the reply.hijack() SSE
      // stream below — ever starts.
      const alreadyCloned = existsSync(path.join(cwd, '.git'));
      const workDirResult = resolveWorkDir(cwd, dir, alreadyCloned);
      if ('error' in workDirResult) {
        return reply.code(400).send(errorBody('BAD_REQUEST', workDirResult.error));
      }
      const refDirsResult = resolveRefDirs(cwd, refDirs, alreadyCloned);
      if ('error' in refDirsResult) {
        return reply.code(400).send(errorBody('BAD_REQUEST', refDirsResult.error));
      }
      const { workDir, verifyAfterClone: workDirNeedsVerify } = workDirResult;
      const { refDirs: resolvedRefDirs, verifyAfterClone: refDirsNeedVerify } = refDirsResult;
      const verifyAfterClone = workDirNeedsVerify || refDirsNeedVerify;
      // When the repo isn't cloned locally yet, `workDir` (a subdirectory of
      // it) doesn't exist on disk either — spawning the agent there would hit
      // the same ENOENT issue `mkdir` above exists to avoid. Fall back to the
      // repo root, which `mkdir` did just create; the prompt's verify step
      // (buildStagePrompt) is what actually enforces `dir`/`refDirs` in that
      // case.
      const stageCwd = workDirNeedsVerify ? cwd : workDir;

      // Best-effort, unlike the usage-limit gate above: a repo's instructions
      // are a prompt-quality enhancement, not an enforcement/billing gate, so
      // a Mongo hiccup here should cost personalization for this run, not the
      // run itself (same philosophy as the recorder — see src/db/recorder.ts).
      let additionalContext: string | undefined;
      try {
        const instructions = await options.repoInstructions.listActiveForRepo(repoUrl);
        const formatted = formatRepoInstructions(repoUrl, instructions);
        additionalContext = formatted === '' ? undefined : formatted;
      } catch (error) {
        request.log.warn(
          { error, repoUrl },
          'failed to load repo instructions; continuing without them',
        );
      }

      const redact = (text: string) => redactSecret(options.config.git.token, text);

      // Persists this run's conversation/tool calls/usage to MongoDB
      // (src/db) under two identifiers: the Agent SDK sessionId and the
      // gateway-verified caller (JWT `sub`, falling back to `email`).
      // Best-effort by design — a persistence failure is logged, never
      // surfaced to the caller or allowed to break the run.
      const recorder = createRunRecorder({
        userId,
        ...(userEmail !== undefined && { userEmail }),
        repoSlug: repoSlug(repoUrl),
        request: {
          prompt,
          repoUrl,
          ...(sessionId !== undefined && { sessionId }),
          ...(dir !== undefined && { dir }),
          ...(refDirs !== undefined && { refDirs }),
        },
        redact,
        log: request.log,
      });

      const stagePrompt = buildStagePrompt({
        repoDir: cwd,
        workDir,
        refDirs: resolvedRefDirs,
        verifyAfterClone,
        repoUrl,
        token: options.config.git.token,
        task: prompt,
      });

      // Takes the raw response over from Fastify: an SSE stream writes
      // events as the pipeline runs rather than one JSON body at the end,
      // so Fastify's normal "return a value, we serialize it" flow doesn't
      // apply here.
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const sendEvent = (event: string, data: unknown) => {
        const payload = redact(JSON.stringify(data));
        reply.raw.write(`event: ${event}\ndata: ${payload}\n\n`);
      };

      // A comment line (per the SSE spec, anything after `:` is ignored by
      // clients) sent periodically so proxies/load balancers that drop
      // idle connections don't close the stream during a long-running tool
      // call (e.g. git_clone on a large repo).
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

      try {
        const results = await options.run({
          stages: [
            {
              name: 'trigger',
              prompt: stagePrompt,
              cwd: stageCwd,
              ...(sessionId !== undefined && { resume: sessionId }),
              ...(resolvedRefDirs.length > 0 && { additionalDirectories: resolvedRefDirs }),
              ...(additionalContext !== undefined && { additionalContext }),
            },
          ],
          policy: options.policy,
          mcpServers: options.mcpServers,
          model: options.config.model,
          onMessage: (_stage, message) => {
            sendEvent(message.type, message);
            recorder.record(message);
          },
        });

        const ok = results.every((result) => result.ok);
        const donePayload = {
          ok,
          repoUrl,
          slug: repoSlug(repoUrl),
          results,
          sessionId: results.at(-1)?.sessionId,
        };
        sendEvent('done', donePayload);
        await recorder.finalize('done', donePayload);
      } catch (error) {
        request.log.error(error);
        const errorPayload = {
          ok: false,
          repoUrl,
          error: error instanceof Error ? error.message : String(error),
        };
        sendEvent('error', errorPayload);
        await recorder.finalize('error', errorPayload);
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    },
  );
}
