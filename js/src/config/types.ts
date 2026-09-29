import type { PolicyConfig } from '@/guardrails/index.js';
import type { Env } from './env.js';

export interface AppConfig {
  /** Path to the JSON/YAML file holding the guardrail policy for this environment. */
  policyPath: string;
  /** Guardrail policy overrides loaded from policyPath, merged over DEFAULT_POLICY. */
  policy: Partial<PolicyConfig>;
  logLevel: Env['PIPELINE_LOG_LEVEL'];
  /** Model id passed to every stage's query() call (src/pipeline/index.ts). */
  model: string;
  /** Git identity used by the git MCP server (src/mcp/index.ts) for commit/push. */
  git: {
    token: string;
    email: string;
    name: string;
  };
  /** Fastify trigger server bind address (src/server). */
  trigger: {
    port: number;
    host: string;
  };
  /**
   * Per-user usage limits enforced by POST /v1/trigger before a run starts
   * (src/db/usage.ts). Unset `max*` fields are unlimited; with all three
   * unset, limiting is off and no usage query runs.
   */
  usageLimits: {
    /** Rolling window (hours) the limits below are summed over. */
    windowHours: number;
    /** Max summed run cost (USD) per user per window. */
    maxCostUsd?: number;
    /** Max summed input+output tokens per user per window. */
    maxTokens?: number;
    /** Max runs started per user per window. */
    maxRuns?: number;
  };
  /** MongoDB persistence for conversations/tool calls/usage (src/db). */
  mongo: {
    uri: string;
    /** Overrides the database named in `uri` when set (mongoose `dbName`). */
    dbName?: string;
    /** Apply pending migrations on startup (default) vs. via the deploy-step CLI. */
    autoMigrate: boolean;
  };
}
