import { parseEnv } from './env.js';
import type { AppConfig } from './types.js';

/**
 * Loads process-level configuration from the environment. Policy *contents*
 * are read later, by the guardrails loader, from `policyPath` — this only
 * resolves where to find them. Validation of the raw env vars themselves
 * happens in `parseEnv` (env.ts) — this function only shapes the validated
 * result into `AppConfig`.
 */
export function loadAppConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = parseEnv(env);
  return {
    policyPath: parsed.PIPELINE_POLICY_PATH,
    policy: {},
    logLevel: parsed.PIPELINE_LOG_LEVEL,
    model: parsed.PIPELINE_MODEL,
    git: {
      token: parsed.GIT_TOKEN,
      email: parsed.GIT_EMAIL,
      name: parsed.GIT_NAME,
    },
    trigger: {
      port: parsed.PORT,
      host: parsed.HOST,
    },
    usageLimits: {
      windowHours: parsed.USAGE_LIMIT_WINDOW_HOURS,
      ...(parsed.USAGE_LIMIT_MAX_COST_USD !== undefined && {
        maxCostUsd: parsed.USAGE_LIMIT_MAX_COST_USD,
      }),
      ...(parsed.USAGE_LIMIT_MAX_TOKENS !== undefined && {
        maxTokens: parsed.USAGE_LIMIT_MAX_TOKENS,
      }),
      ...(parsed.USAGE_LIMIT_MAX_RUNS !== undefined && {
        maxRuns: parsed.USAGE_LIMIT_MAX_RUNS,
      }),
    },
    mongo: {
      uri: parsed.MONGODB_URI,
      ...(parsed.MONGODB_DB_NAME !== undefined && { dbName: parsed.MONGODB_DB_NAME }),
      autoMigrate: parsed.MONGODB_AUTO_MIGRATE === 'true',
    },
  };
}

export { type Env, envSchema, parseEnv } from './env.js';
export type { AppConfig } from './types.js';
