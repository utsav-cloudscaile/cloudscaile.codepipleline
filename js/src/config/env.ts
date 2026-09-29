import { z } from 'zod';

/**
 * Schema for every environment variable the process reads. This is the single
 * source of truth for what's required vs optional/defaulted — `loadAppConfig`
 * (index.ts) maps the parsed result onto `AppConfig`, it doesn't re-validate.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  // Model id passed to the Agent SDK's query() (see src/pipeline/index.ts) —
  // without this, query() falls back to the CLI's own default model. Defaults
  // to the latest Haiku: cheap/fast for local testing, not a production
  // recommendation — override explicitly per environment.
  PIPELINE_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  PIPELINE_POLICY_PATH: z.string().min(1).default('./pipeline.policy.json'),
  PIPELINE_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Git identity used by the git MCP server for clone/commit/push (see src/mcp/index.ts).
  GIT_TOKEN: z.string().min(1, 'GIT_TOKEN is required'),
  GIT_EMAIL: z.email('GIT_EMAIL must be a valid email address'),
  GIT_NAME: z.string().min(1, 'GIT_NAME is required'),
  // Fastify trigger server (src/server).
  PORT: z.coerce.number().int().positive().default(8000),
  HOST: z.string().min(1).default('127.0.0.1'),
  // MongoDB persistence (src/db) — conversations, tool calls, usage records.
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  // Optional override of the database named in MONGODB_URI. No default on
  // purpose: a default here would silently override a db name embedded in the
  // URI path (mongoose's `dbName` option wins over the URI).
  MONGODB_DB_NAME: z.string().min(1).optional(),
  // 'true' (default): apply pending migrations on startup, before the server
  // listens. Set 'false' when a deploy step runs `pnpm migrate` /
  // `node dist/db/migrate.js up` instead (multi-instance rollouts).
  MONGODB_AUTO_MIGRATE: z.enum(['true', 'false']).default('true'),
  // Per-user usage limits for POST /v1/trigger (src/db/usage.ts), evaluated
  // over a rolling window against the persisted usage ledger. Each MAX_* is
  // optional — unset means that dimension is unlimited, and with none set the
  // check is skipped entirely (no DB query per trigger).
  USAGE_LIMIT_WINDOW_HOURS: z.coerce.number().positive().default(24),
  USAGE_LIMIT_MAX_COST_USD: z.coerce.number().positive().optional(),
  // Counts input + output tokens; cache read/creation tokens are excluded
  // (their price is already reflected in cost — cap spend via MAX_COST_USD).
  USAGE_LIMIT_MAX_TOKENS: z.coerce.number().int().positive().optional(),
  USAGE_LIMIT_MAX_RUNS: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates `process.env` (or a supplied env map, for tests)
 * against `envSchema`. Fails fast with a readable, multi-line error naming
 * every invalid/missing var, rather than surfacing a confusing runtime error
 * later when a stage or the trigger server first needs the value.
 */
export function parseEnv(env: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
