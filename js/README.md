# code-pipeline

An agentic pipeline for prompt-driven codebase updates. It runs on the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), reads
skills and a `CLAUDE.md` for task-specific instructions, and — where a
pipeline stage needs it — calls out over MCP to update the configuration of
the platform the code will run on (e.g. environment/config-as-code on a
downstream deployment platform).

All of that is gated by a **configurable guardrail policy**: which tools
(including MCP tools) a run is allowed to use, which are always denied, and
which require out-of-band approval, independent of code changes.

## Architecture

```
src/
  config/      process-level configuration: zod-validated env vars, policy file location
  guardrails/  the PolicyConfig type + resolvePolicy/evaluateTool (allow/deny/approval),
               and loadPolicy to read the on-disk override file
  logger/      pino-based logger, pretty in dev / JSON in production
  auth/        decode-only JWT auth (the gateway in front of this service verifies the signature)
  mcp/         MCP server registry for the target platform(s), incl. the git server
    git/       pure workspace helpers (clone path, token-authed URL) for the git MCP server
  pipeline/    pipeline stage types, master-context loader, and the query() orchestration
  server/      Fastify trigger server (POST /trigger)
master/        standing instructions + skills prepended to every pipeline run
```

- **config** resolves configuration from the environment via a zod schema
  (`src/config/env.ts`) — `loadAppConfig()` fails fast with a readable error
  if something required (e.g. `GIT_TOKEN`) is missing or invalid.
- **guardrails** owns the guardrail policy itself: a base `DEFAULT_POLICY`,
  merged with environment/tenant overrides via `resolvePolicy`, evaluated per
  tool call via `evaluateTool`. `loadPolicy` reads the on-disk override file.
  See [`pipeline.policy.example.json`](pipeline.policy.example.json) for the
  on-disk shape.
- **logger** provides `createLogger(logLevel)`, a thin [pino](https://getpino.io)
  wrapper — colorized output via `pino-pretty` unless `NODE_ENV=production`,
  in which case it's structured JSON and `pino-pretty` isn't needed at
  runtime.
- **auth** decorates the Fastify instance with `authenticate` — decodes the
  `Authorization: Bearer <jwt>` header (no signature check; an upstream API
  gateway already verified it) into `request.user`. Applied to every route
  except `/open/*`.
- **mcp** registers MCP servers for downstream platforms (`buildMcpServers`),
  passed into the Agent SDK's `mcpServers` option. Ships with a `git` server
  ([`@cyanheads/git-mcp-server`](https://www.npmjs.com/package/@cyanheads/git-mcp-server))
  for clone/pull/commit/push against an arbitrary target repo.
- **pipeline** defines a `PipelineStage` (name + prompt + optional `cwd`) and
  `runPipeline`, which drives the Agent SDK `query()` loop per stage,
  translating the resolved policy into `allowedTools` / `disallowedTools` /
  `permissionMode`, gating `'approval-required'` tools through `canUseTool`,
  and prepending `master/`'s standing context to the system prompt.
- **server** exposes `POST /trigger`, the entry point that ties everything
  together — see "Triggering a run" below.
- **master/** (`master/INSTRUCTIONS.md`, `master/skills/*/SKILL.md`) is
  prepended to every stage's prompt regardless of which repo it targets —
  edit it to change what every run is told.

## Requirements

- Node.js >= 24
- pnpm (see `devEngines` in `package.json`)

## Setup

```bash
pnpm install
cp .env.example .env                                  # then fill in the values below
cp pipeline.policy.example.json pipeline.policy.json  # then edit for your environment
```

`pnpm install` also registers the git hooks (`lefthook install`, wired via
the `prepare` script).

Env vars (`src/config/env.ts` is the source of truth; `loadAppConfig()` fails
fast if any required one is missing):

| Var | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Agent SDK auth |
| `GIT_TOKEN` | yes | Auth for cloning/pushing the target repo (git MCP server) |
| `GIT_EMAIL`, `GIT_NAME` | yes | Commit author identity |
| `PIPELINE_POLICY_PATH` | no (default `./pipeline.policy.json`) | Guardrail policy override file |
| `PIPELINE_LOG_LEVEL` | no (default `info`) | `debug` \| `info` \| `warn` \| `error` |
| `PORT` | no (default `8000`) | Fastify trigger server port |
| `HOST` | no (default `127.0.0.1`) | Trigger server bind address — stays off `0.0.0.0` by default |

## Scripts

| Script                | Purpose                                            |
| ---------------------- | --------------------------------------------------- |
| `pnpm dev`             | Run `src/index.ts` with `tsx`, watching for changes |
| `pnpm build`           | Transpile `src/` to `dist/` (tsup) + emit `.d.ts` (tsc) |
| `pnpm typecheck`       | `tsc --noEmit` over `src/` and `tests/`              |
| `pnpm lint`            | Biome lint                                           |
| `pnpm format`          | Biome format, writing changes                        |
| `pnpm check`           | Biome lint + format + import sort, writing changes    |
| `pnpm test`            | Run the Vitest suite once                            |
| `pnpm test:watch`      | Run Vitest in watch mode                             |

## Guardrails

Guardrail policy is data, not code, so it can change per environment/tenant
without a redeploy. It's a `PolicyConfig`:

```ts
interface PolicyConfig {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  allowedTools: string[];      // glob patterns, e.g. "mcp__platform__get_*"
  deniedTools: string[];       // always wins over allowedTools
  requireApproval: string[];   // allowed, but needs human/external sign-off
}
```

`resolvePolicy(base, overrides)` unions array fields (so overrides can only
add restrictions/permissions, never silently drop base entries) and lets
overrides replace scalar fields. `evaluateTool(policy, toolName)` returns
`'allow' | 'deny' | 'approval-required'` — deny-by-default: a tool not
matched by `allowedTools` is denied.

## Triggering a run

With `pnpm dev` running, `POST /trigger`:

```bash
curl -N -X POST http://127.0.0.1:8000/trigger \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <jwt from the API gateway>' \
  -d '{
    "prompt": "Add a health check route at GET /health returning { status: \"ok\" }.",
    "repoUrl": "https://github.com/Cloudscaile-Experience/test-code-pipeline.git"
  }'
```

`repoUrl` is required. This route also requires an `Authorization: Bearer
<jwt>` header — this service only decodes it (an API gateway in front of it
verifies the signature); see `CLAUDE.md`'s "Trigger server" / "Auth" sections
for the trust model. The server clones the repo (or pulls, if it's
already been cloned into `tmp/workspaces/`), runs the pipeline against it
with `master/`'s standing instructions plus your prompt, and — per this
repo's guardrail policy — commits and pushes the result unattended, with no
human approval step in between.

Two optional fields scope the agent's filesystem access within the repo:
`dir` (a relative path) narrows the agent's own working directory to a
subdirectory, and `refDirs` (`{ path: string }[]`) grants read/write access to
extra directories beyond `dir` — e.g. a shared package a `dir`-scoped run
still needs to see. Both are checked against the cloned repo on disk when
possible, failing the request with a `400` if the path doesn't exist;
otherwise the check is included in the stage prompt itself once the repo's
been cloned.

The response is a Server-Sent Events stream (`-N` above disables curl's
output buffering so events show up as they arrive), not one JSON body: every
SDK message the pipeline emits — assistant text, tool calls, tool results —
is forwarded as its own `event: <message.type>` as soon as it happens, so a
long-running change (e.g. a slow `git_clone`) isn't a silent wait. The
stream ends with a `done` event (or `error`, if the run threw) carrying the
same summary the response used to return as JSON, plus a `sessionId`. Pass
that back as `sessionId` in a later `POST /trigger` call, with the same
`repoUrl`, to resume that exact conversation instead of starting a fresh
one:

```bash
curl -N -X POST http://127.0.0.1:8000/trigger \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <jwt from the API gateway>' \
  -d '{
    "prompt": "Also add a /health/live route.",
    "repoUrl": "https://github.com/Cloudscaile-Experience/test-code-pipeline.git",
    "sessionId": "<sessionId from the previous run'\''s done event>"
  }'
```

### API docs

Interactive Swagger UI, generated from the same zod schema that validates
`POST /trigger`, is served at
[`/open/docs`](http://127.0.0.1:8000/open/docs) while the server is running;
the raw OpenAPI document is at
[`/open/openapi.json`](http://127.0.0.1:8000/open/openapi.json). Both come
from `@fastify/swagger` + `@fastify/swagger-ui`, wired via
`fastify-type-provider-zod` (`src/server/index.ts`) — a new route only shows
up here if it's registered with a `schema` (see the `/trigger` route for the
pattern).

## Testing

[Vitest](https://vitest.dev) (`vitest.config.ts`), tests under `tests/`
mirroring the `src/` layout.

## Git hooks

[Lefthook](https://lefthook.dev) (`lefthook.yml`):

- **pre-commit**: `biome check --write` on staged files
- **pre-push**: `typecheck` then `test`

## Docker

```bash
docker build -t code-pipeline .
docker run --rm --init -p 8000:8000 --env-file .env -e HOST=0.0.0.0 code-pipeline
```

`Dockerfile` is a multi-stage build: install (pnpm, frozen lockfile) → compile
(`tsup` to `dist/`, then `pnpm prune --prod`) → runtime (`node:24-slim`,
production `node_modules` + `dist` only, runs as the non-root `node` user).
Pass `--init` so PID 1 forwards signals correctly (no `dumb-init`/`tini` baked
into the image). `EXPOSE 8000` matches `PORT`'s default; the server
binds to `HOST` (default `127.0.0.1`), so publish the port *and* set
`HOST=0.0.0.0` to reach it from outside the container.

## Skills

Project skills live in [.claude/skills/](.claude/skills/) and extend Claude
Code when working in this repo: `add-mcp-server`, `add-guardrail-rule`,
`add-pipeline-stage`. See [CLAUDE.md](CLAUDE.md) for repo conventions.
