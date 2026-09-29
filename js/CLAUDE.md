# code-pipeline

Agentic pipeline (built on `@anthropic-ai/claude-agent-sdk`) that applies
prompt-driven updates to a codebase and, via MCP, to the configuration of the
platform that code runs on. See [README.md](README.md) for architecture.

This `js/` directory is not the git repo root — the repo root is one level up
and holds `manifest.json` (the platform extension manifest: names this the
`codePipeline` extension and declares its `mongo` backend dependency) and
`lefthook.yml` (see "Before committing"). Everything else about the service
lives here in `js/`.

## Current state

No longer scaffolding-only: `runPipeline` (`src/pipeline/index.ts`) drives
the Agent SDK's `query()` per stage, `buildMcpServers` (`src/mcp/index.ts`)
registers a real `git` MCP server, and `src/server` exposes a Fastify
`POST /trigger` endpoint that clones/pulls a target repo, runs the pipeline
against it, and commits/pushes the result. Entry point is `src/index.ts`
(`main()` — only runs when the file is executed directly, e.g. `pnpm dev` /
`node dist/index.js`; its exports stay import-safe for tests).

- `src/config/env.ts` — zod schema validating every env var; `loadAppConfig`
  fails fast with a readable error if something required is missing.
- `src/mcp/git/workspace.ts` — pure helpers (`repoSlug`, `workspaceDir`,
  `withTokenAuth`) the trigger server uses to compute a target repo's local
  clone path and an authenticated remote URL before handing either to the
  git MCP server. `WORKSPACE_ROOT` (`tmp/workspaces/`, gitignored) is also
  passed to the git MCP server as `GIT_BASE_DIR`, sandboxing every git tool
  call to that directory tree.
- `src/pipeline/masterContext.ts` — reads `master/INSTRUCTIONS.md` and every
  `master/skills/*/SKILL.md` and prepends them (via `systemPrompt`'s
  `preset: 'claude_code', append: ...`) to every stage's prompt. Edit
  `master/` to change what every pipeline run is told regardless of the
  specific prompt — see "Master context" below.
- `src/guardrails/loadPolicy.ts` — reads `pipeline.policy.json` (gitignored;
  `cp pipeline.policy.example.json pipeline.policy.json` first) and merges it
  over `DEFAULT_POLICY` via `resolvePolicy`. The server won't start without a
  policy file present at `PIPELINE_POLICY_PATH`.

## Conventions

- TypeScript, strict mode, ESM only (`"type": "module"`, `NodeNext` module
  resolution). Relative imports between local files must include the `.js`
  extension (e.g. `from './policy.js'`), even though the source is `.ts` —
  this is required by `NodeNext` resolution, not a typo.
- `@/*` is a path alias for `src/*` (`tsconfig.json` `paths`). Use it for
  imports that cross out of the current directory (e.g.
  `from '@/guardrails/index.js'`); keep same-directory imports relative
  (`from './policy.js'`). Still include the `.js` extension — the alias
  doesn't change NodeNext's extension requirement. `@/` only works because of
  three separate pieces of tooling, all of which must keep agreeing: `tsx`
  resolves it natively at dev time, Vitest via `resolve.tsconfigPaths: true`
  (`vitest.config.ts`), and the production build via `tsc-alias` rewriting it
  back to relative paths after `pnpm build`'s two compile steps (`tsup` for
  JS, `tsc --emitDeclarationOnly` for `.d.ts` — see "Build" below) — neither
  tsup (esbuild, transform-only) nor `tsc` rewrites path aliases in emitted
  output on its own.
- Formatting and linting are both Biome (`biome.json`) — no ESLint, no
  Prettier. Run `pnpm check` before committing; the pre-commit hook runs it
  on staged files automatically.
- Single quotes, semicolons, trailing commas — Biome enforces this, don't
  hand-format against it.
- Each `src/<area>/` exposes its public surface through `index.ts`; other
  areas import through it (`@/guardrails/index.js`), never an internal file
  directly (`@/guardrails/policy.js`). Tests are the one exception — they
  import the internal file directly to unit-test it in isolation.
- Tests live in `tests/`, mirroring the `src/` path being tested
  (`src/guardrails/policy.ts` → `tests/guardrails/policy.test.ts`), using
  Vitest (`describe`/`it`/`expect`).

## Guardrails are policy, not code

`src/guardrails/policy.ts` is the enforcement point for what the pipeline is
allowed to touch — including MCP tools that mutate the target platform's
config. When extending the pipeline:

- New capabilities (new MCP tools, new local tools) must be reachable only
  through `evaluateTool`, not invoked unconditionally.
- Deny-by-default: a tool not matched by `allowedTools` is denied, even with
  an empty `deniedTools`. Don't change this default without discussion — it's
  the safety baseline for a system that can push config changes to another
  platform.
- `deniedTools` always overrides `allowedTools`. Don't special-case exceptions
  to this in stage code; add a narrower `allowedTools` glob instead.
- Prefer adding/editing patterns in `pipeline.policy.example.json` (the
  documented template) over hardcoding tool names in `src/pipeline`.
- Two documented, deliberate exceptions to "irreversible/high-blast-radius →
  `requireApproval`" live in `pipeline.policy.example.json` today
  (`$comment_edit_write`, `$comment_git_push`): `Edit`/`Write` are plain
  `allowedTools` because they're this pipeline's core capability, not a
  side effect, and `mcp__git__git_push` is plain `allowedTools` because the
  trigger server's whole point is unattended clone→edit→commit→push. Both
  were explicit product decisions, not defaults — don't quietly extend that
  reasoning to a new tool without the same kind of explicit call.
- `canUseTool` (`src/pipeline/index.ts`) is the real, authoritative
  deny-by-default enforcement — it calls `evaluateTool(policy, toolName,
  input)` for every tool attempt and denies unless the result is `'allow'`
  (or `'approval-required'` with a granted `approvalHandler`).
  `allowedTools`/`disallowedTools` are also passed straight through to
  `query()` as a coarse pre-filter, but that's belt-and-suspenders, not the
  real gate — **an earlier version of this file had `canUseTool` return
  `{behavior:'allow'}` for anything not `'approval-required'`, trusting the
  coarse filter to have already denied everything else. It hadn't:** the
  model ran arbitrary `Bash` commands, including plain `git`, because
  nothing was actually re-checking the parameterized `allowedTools` entries
  against the real command. `evaluateTool` now accepts an optional `input`
  so it can match `"Tool(content-pattern)"` entries (e.g. `"Bash(npm *)"`)
  against the call's real input, not just the bare tool name — don't
  reintroduce a blanket allow in `canUseTool` for "anything not
  approval-required."
- The SDK itself warns at runtime (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`): a
  **bare** `allowedTools` entry (an exact name or plain glob, e.g. `"Read"` or
  `"mcp__git__git_status"`) auto-approves that tool before `canUseTool` is
  even called — only **parameterized** entries (`"Tool(content-pattern)"`)
  and tools absent from `allowedTools` fall through to `canUseTool`. This is
  why the fix above matters specifically for parameterized/unlisted tools;
  for bare-listed ones, `evaluateTool` and the SDK's own matcher agree
  anyway, so there's no gap in practice — but a tool that needs *per-call*
  gating (not just "is this tool name allowed at all") can't be a bare
  `allowedTools` entry, since `canUseTool` won't see those calls. Use a
  `PreToolUse` hook for that case instead, per the SDK's own suggestion.

## MCP servers

Register new downstream-platform MCP servers in `buildMcpServers`
(`src/mcp/index.ts`) — a function, not a static export, since servers may
need validated config (e.g. the `git` server needs `AppConfig['git']`). Each
server's tools should get corresponding `allowedTools` / `requireApproval`
glob entries using the SDK's `mcp__<server>__<tool>` naming convention — see
`pipeline.policy.example.json` for the pattern, and the registered `git`
server (`@cyanheads/git-mcp-server`, exact-pinned in `package.json`, not
`npx -y ...@latest`) as a fully worked example. Confirm a new server's real
tool names/schemas (e.g. via `npx @modelcontextprotocol/inspector --cli npx
-y <pkg> --method tools/list`) before writing policy entries — don't guess.

## Master context

`master/INSTRUCTIONS.md` + `master/skills/*/SKILL.md` are standing
instructions prepended to every pipeline stage's prompt, regardless of which
repo it's pointed at or what the caller's specific prompt asks for — they
describe how to behave in an arbitrary **target** repo (match its own
conventions, verify before committing, keep commits scoped), not conventions
for this repo. Edit them to change what every run is told; `loadMasterContext`
(`src/pipeline/masterContext.ts`) treats a missing `master/` dir or an empty
`skills/` subdirectory as "no extra context" rather than an error, so this
stays optional infrastructure, not a hard dependency.

## Trigger server (HTTP API)

`src/server` is split the standard way: `index.ts` is the composition root
(`buildServer`, `async` — it awaits registering
`@fastify/swagger`/`@fastify/swagger-ui` before adding routes, see below;
plus the global error/not-found handlers), `routes/v1/*.ts` hold one file
per resource registered under the **`/v1` prefix** (a breaking change ships
as `/v2` alongside, never as a silent contract change), and `schemas/*.ts`
hold the zod contracts. `schemas/common.ts` is load-bearing: every JSON
response uses its single success (`{ success: true, data }`) / error
(`{ success: false, error: { code, message } }`) envelope — enforced
globally by `setErrorHandler`/`setNotFoundHandler` in `index.ts`, so
validation 400s, auth 401s, unknown routes, and 500s all look identical to
clients — and every paginated route uses its one `page`/`limit` query
contract and `pagination` meta block (`paginatedResponseSchema`). Don't
invent per-route envelopes or pagination variants.

`POST /v1/trigger` (`routes/v1/trigger.ts`) — body `{ prompt: string,
repoUrl: string, sessionId?: string, dir?: string, refDirs?: { path:
string }[] }`. `repoUrl` is required (no default). Its SSE frames and final
`done` payload are the one deliberate exception to the envelope — they're
the persisted replay format (src/db), predating it; only its pre-stream
400s are enveloped. `dir` is a relative path scoping the agent's own working
directory to a subdirectory of the repo; `refDirs` are extra relative paths
the agent can read/write beyond `dir`, passed through as the Agent SDK's
`additionalDirectories` option (see `resolveWorkDir`/`resolveRefDirs`,
`src/server/routes/v1/trigger.ts`) — real SDK support for widening directory access, unlike
per-file line-range references, which the SDK has no mechanism for. Both are
validated against the already-cloned repo on disk when possible (a plain `400`
if the path doesn't exist); when the repo hasn't been cloned yet, the check is
deferred to the stage prompt itself, since there's nothing on disk yet to
check against. The handler computes the workspace path
(`src/mcp/git/workspace.ts`), tells the stage prompt whether to `git_clone` or
`git_pull` based on whether that path already has a `.git` directory (a
deterministic check, not left to the model to figure out), then runs
`runPipeline` with one stage there. This route requires a gateway-forwarded
JWT (`onRequest: app.authenticate` — see "Auth" below); it also still binds
to `HOST` (default `127.0.0.1`, not `0.0.0.0`) as a minimal safety
net regardless of auth. Don't add or remove auth on a route as a silent side
effect of an unrelated change — call it out explicitly, the same way this
route's auth requirement itself was a deliberate, called-out change.

### Usage limits

`POST /v1/trigger` enforces configurable per-user usage limits
(`src/db/usage.ts`) before a run starts — the ledger-then-aggregate pattern
LLM gateways use for budgets (LiteLLM `max_budget`, Traefik Hub token
quotas), built on the `usage_records` ledger that was designed for exactly
this. Env: `USAGE_LIMIT_WINDOW_HOURS` (rolling window, default 24) plus
optional `USAGE_LIMIT_MAX_COST_USD` / `USAGE_LIMIT_MAX_TOKENS` (input+output
only — cache tokens are priced into cost) / `USAGE_LIMIT_MAX_RUNS`. With no
`MAX_*` set, limiting is off and no usage query runs per trigger. A capped
caller gets a `429` `USAGE_LIMIT_EXCEEDED` envelope before any workspace
side effect or the SSE stream. Load-bearing details:

- `evaluateUsageLimits` is the pure decision (unit-tested in isolation);
  `usageQueries.usageSince` is the impure window aggregate behind the
  `UsageQueries` seam (`BuildServerOptions.usageQueries`) — same pattern as
  `SessionQueries`. Don't inline new limit math into the route handler.
- Cost/tokens sum `usage_records` (written at run *end*); the run count
  comes from `runs` (written at run *start*), so a concurrent burst is
  counted before any usage record lands. An off-the-shelf rate limiter can't
  replace this — it counts requests at admission, not cost/tokens known only
  after a run.
- Limits are compared at `>=` and post-paid: a window can overshoot by at
  most the one run that crossed the line — deliberate, matching how LLM
  budget systems behave; don't "fix" it by pre-charging estimates.
- Unlike the best-effort recorder, this check **fails closed** (503 via
  `requireConnected`) when limits are configured but MongoDB is down — an
  enforcement gate that silently passes during an outage isn't a gate.

Read routes (`routes/v1/sessions.ts`, backed by `src/db/queries.ts`):
`GET /v1/sessions` lists the **caller's** conversations (minimal summaries,
newest activity first); `GET /v1/sessions/:sessionId/messages` returns one
conversation in order (optionally `?runId=` to narrow to a single trigger
run, `?events=` to narrow to one or more SDK event types (repeat the param
or comma-separate, e.g. `?events=assistant,result`) to skip system/thinking
noise) — each item carries the same `event`/`payload`
pair the live SSE stream emitted; `GET /v1/sessions/:sessionId/tool-calls`
returns that conversation's tool calls instead (optionally the same `?runId=`
plus `?category=` — `file_change | git | command | read | mcp | other`) — a
dedicated endpoint over the `tool_calls` collection rather than another
`messages` filter, since a tool call's shape (name/category/input/result/
status) isn't an SDK event and would otherwise mean scanning every message
payload for `tool_use`/`tool_result` blocks. The first message of each run in
`/messages` is a synthetic `user_prompt` event (`createRunRecorder`,
src/db/recorder.ts) carrying the caller's original prompt — the Agent SDK
never streams the caller's own prompt back as a message of its own, so
without this a stored conversation showed only the assistant/tool activity
with no record of what was actually asked; its `event`/`subtype` are
deliberately namespaced away from the SDK's own `'user'` message type (tool
results) so a client can tell the two apart. Ownership is enforced in the
query layer, not the handlers: every query filters by the JWT's userId
(`callerIdentity`, src/auth), and a session that exists but belongs to
someone else 404s identically to one that doesn't exist. Unlike the
best-effort write-side recorder (see "Persistence"), read queries require a
live MongoDB connection: `requireConnected` (src/db/queries.ts) fails them
with a 503 `SERVICE_UNAVAILABLE` envelope — deliberately one of the only 5xx
whose message is exposed to clients (`setErrorHandler` in
`src/server/index.ts`), since "retry later" is client-actionable. Keep new
read queries in `src/db/queries.ts` behind the `SessionQueries` interface —
it's the test seam (`BuildServerOptions.sessionQueries`), same pattern as
`runPipelineFn`.

Interactive docs (`@fastify/swagger` + `@fastify/swagger-ui`, wired through
`fastify-type-provider-zod` so the same zod schema both validates requests
and generates the OpenAPI doc — no separate schema to keep in sync) are at
`DOCS_ROUTE_PREFIX` (`/open/docs`) and `OPENAPI_JSON_ROUTE`
(`/open/openapi.json`), both exported from `src/server/index.ts`. **Always
`await` these two `app.register()` calls before adding a route** —
`@fastify/swagger` captures schemas via an `onRoute` hook wired up while its
plugin body runs; registering a route before that (e.g. a fire-and-forget
`void app.register(...)`) means it silently never shows up in the generated
doc, even though the route itself still works fine. A new route only appears
in the docs if it's registered with a `schema` object, same as the `/v1/*` routes.

### Auth

This service sits behind an API gateway that terminates and verifies the
caller's JWT before forwarding the request here — this service never
verifies a signature. `src/auth` (`registerAuth`) decorates the Fastify
instance with `authenticate`, a preHandler that decode-only-parses the
`Authorization: Bearer <jwt>` header into `request.user`
(`src/auth/jwt.ts`'s `decodeJwtPayload`, no signature check) and responds
`401` if the header is missing or the token doesn't even parse as a JWT.
This mirrors the pattern in the patient-management-portal template
(`src/hooks/auth.ts` there): the gateway is the trust boundary, this service
only needs the payload to know *who* asked for a run (currently used for
audit logging via `request.log.info({ user: request.user }, ...)` and as the `userId` every
persistence read/write is scoped by — via `callerIdentity`, which resolves
`sub` → `email` → `'unknown'`).

Any route whose path starts with `/open/` (the existing convention for
`DOCS_ROUTE_PREFIX`/`OPENAPI_JSON_ROUTE`) is exempt — it must not get
`onRequest: app.authenticate`. Every other route must. All `/v1/*` routes
(`trigger`, both `sessions` reads) are protected; if you add another route
outside `/open/`, wire `onRequest: app.authenticate` into its route options the same
way, and know that the OpenAPI doc will mark it as requiring the `Bearer`
scheme automatically (see below) — no per-route schema change needed for
that part.

The OpenAPI doc's `transformObject` (in `src/server/index.ts`, alongside the
`fastifySwagger` registration) walks the generated doc after the fact and
tags every operation whose path does **not** start with `/open/` with
`security: [{ Bearer: [] }]`, rather than hand-adding `security` to each
route's schema — so a new non-`/open/` route picks up the "requires auth"
badge in Swagger UI automatically as long as it's actually gated by
`onRequest: app.authenticate` too. The two are independent (one documents,
the other enforces) — keep them in sync by hand; nothing fails loudly if a
route is gated but not `/open/`-exempt-or-not, or vice versa.

This replaces an earlier "no auth on this route" state (see git history) —
that was a deliberate placeholder given this route had no caller identity to
check yet, not a permanent design decision; don't read the git history's old
reasoning as still current.

## Persistence (MongoDB)

`src/db` persists every `/trigger` run to MongoDB via mongoose. Env:
`MONGODB_URI` (required; `docker compose up -d` starts a matching local
instance — see `docker-compose.yml`) and optional `MONGODB_DB_NAME` (no
default on purpose — a default would silently shadow a db named in the URI).
`main()` calls `connectMongo` before the server starts and fails fast (5s
server-selection timeout) if MongoDB is unreachable.

Every document carries the two identifiers later read APIs key on:
`sessionId` (the Agent SDK `session_id` — the same value callers pass back to
resume) and `userId` (JWT `sub`, falling back to `email`). Five collections
(`src/db/models.ts` documents the split): `sessions` (one per conversation;
title + cumulative cost/token rollups), `runs` (one per `/trigger` call;
stores `donePayload`, the exact final SSE body, so future read APIs return
the same format the trigger API streams today), `messages` (one per SDK
message, ordered by `seq`; `event` + redacted `payload` mirror the SSE
frames for byte-compatible replay), `tool_calls` (tool_use correlated with
its tool_result — file changes and git commits/pushes are indexed queries,
not payload scans), and `usage_records` (append-only metering ledger,
indexed `{userId, createdAt}`, for usage limits later).

Rules when touching this area:

- `createRunRecorder` (`src/db/recorder.ts`) is **best-effort by design**:
  it no-ops when mongoose isn't connected (which is how the server tests run
  without a database), serializes writes on an internal promise chain, and
  logs — never throws — on write failure. A persistence outage must cost
  history, not a pipeline run. Don't make the SSE path await individual
  writes.
- Everything persisted goes through the same `redact` the SSE stream uses
  (the stage prompt embeds an authenticated clone URL) — never write a raw
  `SDKMessage` or prompt to the DB without it.
- `src/db/extract.ts` holds the pure, unit-tested facet extractors (same
  pure/impure split as `src/logger`). Extracted fields exist to make queries
  cheap; the redacted `payload` stays the source of truth — prefer adding an
  extractor over re-parsing payloads elsewhere.
- Import mongoose as a **default import** (`import mongoose from
  'mongoose'`) and destructure — it's CJS, and `import { models } from
  'mongoose'` typechecks but throws at runtime under NodeNext ESM.

### Migrations

Schema changes ship as versioned, **forward-only** migrations
(`src/db/migrations/`, engine in `src/db/migrator.ts`) — recorded in the
`schema_migrations` collection, applied in registry order under a
distributed lock (`schema_migrations_lock`, stale-steal after 10 min), no
`down` scripts (roll forward with a new migration instead). Use the
`/add-db-migration` skill rather than re-deriving the rules; the load-bearing
ones:

- The registry (`src/db/migrations/index.ts`) is an **explicit import list**,
  not fs-scanning — an unregistered migration never runs. `validateRegistry`
  rejects duplicate/out-of-order `NNNN-` prefixes at startup.
- Never edit, reorder, or delete an applied migration. Write `up`
  idempotently — a failed run isn't recorded and will be retried.
- **Indexes are migrations, not side effects**: `connectMongo` sets
  `autoIndex: false`, and `0001-baseline-indexes` owns index creation via
  `syncIndexes()`. An index edit in `src/db/models.ts` does nothing until a
  migration syncs the affected model.
- Documents carry `schemaVersion` (`CURRENT_SCHEMA_VERSION`,
  src/db/models.ts); readers treat an absent field as version 1. Bump it
  only for incompatible shape changes, paired with a migration.
- Startup runs pending migrations before the server listens;
  `MONGODB_AUTO_MIGRATE=false` skips that for deployments that run
  `pnpm migrate` / `node dist/db/migrate.js up` (and `migrate:status`) as a
  pipeline step instead — the intended topology for multi-instance rollouts.

## Build

`pnpm build` (`package.json`) is three steps, in order: `tsup` (transpiles
every `src/**/*.ts` to `dist/**/*.js` via esbuild, one file in → one file
out), `tsc -p tsconfig.build.json --emitDeclarationOnly` (generates the
matching `.d.ts` files), then `tsc-alias -p tsconfig.build.json` (rewrites
`@/*` imports to relative paths in both). `tsup.config.ts` sets `bundle:
false` deliberately — several things depend on `dist/` mirroring `src/`'s
directory structure and each file's depth under the repo root:
`GIT_MCP_SERVER_ENTRY` (`src/mcp/index.ts`) walks a fixed number of
directories up from `import.meta.url` to find `node_modules`, and
`node dist/db/migrate.js` (see "Migrations" above) expects that exact path
to exist as its own file, not inlined into a bundle. Don't flip `bundle:
true` without re-deriving both of those. `dts: false` in the same config is
also deliberate: tsup's own declaration step (`rollup-plugin-dts`) bundles
its own TypeScript version internally and crashes against this project's
TypeScript 7 — hence the separate plain `tsc --emitDeclarationOnly` step
instead, using this project's own TypeScript install.

`pnpm typecheck` (`tsc --noEmit`) is unrelated to `pnpm build` and still
does the real type-checking — tsup's esbuild transform only strips types,
it doesn't check them, so a build can succeed on code that wouldn't
typecheck. Don't drop `pnpm typecheck` from CI/hooks on the assumption that
`pnpm build` covers it.

## Logging

`src/logger` wraps [pino](https://getpino.io). `createLogger(logLevel)` takes
an `AppConfig['logLevel']` (from `loadAppConfig()`) — don't construct `pino()`
directly elsewhere. `resolveLoggerOptions` is the pure level/transport
decision, kept separate so it's unit-testable without a real pino instance;
`pino-pretty` (dev-only, colorized) is used unless `NODE_ENV=production`, in
which case output is structured JSON and `pino-pretty` isn't required at
runtime — the Docker image prunes it along with other devDependencies.
Fastify has its own request logger (`buildServer`'s `logger` option,
default on) — pass `logger: false` in tests to keep output quiet.

## Skills

Prefer these over re-deriving the steps: `/add-mcp-server` (register a
downstream-platform MCP server), `/add-guardrail-rule` (allow/deny/require
approval for a tool), `/add-pipeline-stage` (add a stage to `runPipeline`),
`/add-db-migration` (change the MongoDB schema/indexes or backfill data).

## Docker

`Dockerfile` is a multi-stage pnpm build producing a non-root runtime image
(`node dist/index.js`, `EXPOSE 8000` matching `PORT`'s default —
override both together, and publish with `-e HOST=0.0.0.0` since the
default binds to loopback only). Rebuild after changing
`package.json`/lockfile; `.dockerignore` excludes `node_modules`, `dist`, and
test files from the build context, and blanket-excludes `*.md` — with a
carve-out for `master/INSTRUCTIONS.md`/`master/skills/**/SKILL.md`, which
`loadMasterContext` reads at runtime, so keep that carve-out in sync if
`master/`'s layout changes. The `deps` stage installs with `--ignore-scripts`
(root's own `prepare`/lefthook-install script fails without a `.git`
directory in the build context) — this also skips esbuild's own postinstall
(tsup, used by the `build` stage's `pnpm run build`, is esbuild-based), but
that's fine: pnpm still resolves the platform-specific
`@esbuild/<platform>` optionalDependency normally, and esbuild finds its
binary there without needing the postinstall to run. Verified by actually
building the image, not just reasoned about — don't reintroduce
`--ignore-scripts` doubt without re-checking against a real `docker build`.

## Before committing

Lefthook runs `biome check --write` on pre-commit and `typecheck` +
`test` on pre-push. Its config is `../lefthook.yml` at the git repo root,
not in this directory — each job runs with `root: "js/"`, so the hooks
still execute here. Run `pnpm check && pnpm typecheck && pnpm test`
yourself first if making non-trivial changes — don't rely on the hook to
catch issues you could have seen sooner.
