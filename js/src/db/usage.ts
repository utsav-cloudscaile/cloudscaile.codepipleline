/**
 * Per-user usage limiting for POST /v1/trigger — the ledger-then-aggregate
 * pattern LLM gateways use for budgets (LiteLLM's `max_budget`, Traefik Hub's
 * token quotas): every completed run appends a `usage_records` doc (see
 * recorder.ts), and before starting a new run the trigger route sums the
 * caller's window and compares it against the configured limits
 * (`AppConfig['usageLimits']`, env `USAGE_LIMIT_*`).
 *
 * Off-the-shelf rate limiters (@fastify/rate-limit, rate-limiter-flexible)
 * only count *requests* at admission time — they can't cap cost or tokens,
 * which are only known after a run finishes. Hence the split here:
 *
 * - cost/tokens come from `usage_records` (written when a run's result
 *   message arrives), covered by its `{userId, createdAt}` index;
 * - the run count comes from `runs` (written when a run *starts*), so a
 *   burst of concurrent runs is counted before any of them has finished and
 *   produced a usage record.
 *
 * `evaluateUsageLimits` is the pure decision, unit-tested in isolation;
 * `usageQueries` is the impure aggregate behind the `UsageQueries` seam
 * (`BuildServerOptions.usageQueries`), same pattern as `SessionQueries`.
 * Like the read queries — and unlike the best-effort recorder — the check
 * fails closed with a 503 when MongoDB is down: an enforcement gate that
 * silently passes during an outage isn't a gate.
 */
import { RunModel, UsageRecordModel } from './models.js';
import { requireConnected } from './queries.js';

/** Mirrors `AppConfig['usageLimits']`; `| undefined` for exactOptionalPropertyTypes. */
export interface UsageLimitsConfig {
  windowHours: number;
  maxCostUsd?: number | undefined;
  maxTokens?: number | undefined;
  maxRuns?: number | undefined;
}

/** One user's summed usage over the window `usageSince` was asked about. */
export interface UsageWindow {
  costUsd: number;
  /** Input + output tokens (cache tokens excluded — cost already prices them). */
  tokens: number;
  /** Runs started (not just finished) in the window. */
  runs: number;
}

export interface UsageQueries {
  usageSince(userId: string, since: Date): Promise<UsageWindow>;
}

export type UsageLimitVerdict =
  | { exceeded: false }
  | { exceeded: true; limit: 'costUsd' | 'tokens' | 'runs'; message: string };

/** True when at least one limit is configured — the route skips the DB query otherwise. */
export function usageLimitsActive(limits: UsageLimitsConfig): boolean {
  return (
    limits.maxCostUsd !== undefined ||
    limits.maxTokens !== undefined ||
    limits.maxRuns !== undefined
  );
}

/**
 * Compares one user's window usage against the configured limits. A limit is
 * exceeded at `>=`: usage that has *reached* the cap denies the next run
 * (post-paid metering can only stop the run after the one that crossed the
 * line — the standard overshoot-by-at-most-one-run behavior of LLM budgets).
 */
export function evaluateUsageLimits(
  limits: UsageLimitsConfig,
  usage: UsageWindow,
): UsageLimitVerdict {
  const window = `the last ${limits.windowHours}h`;
  if (limits.maxRuns !== undefined && usage.runs >= limits.maxRuns) {
    return {
      exceeded: true,
      limit: 'runs',
      message: `Usage limit exceeded: ${usage.runs} runs in ${window} (limit ${limits.maxRuns}). Try again later.`,
    };
  }
  if (limits.maxCostUsd !== undefined && usage.costUsd >= limits.maxCostUsd) {
    return {
      exceeded: true,
      limit: 'costUsd',
      message: `Usage limit exceeded: $${usage.costUsd.toFixed(2)} spent in ${window} (limit $${limits.maxCostUsd}). Try again later.`,
    };
  }
  if (limits.maxTokens !== undefined && usage.tokens >= limits.maxTokens) {
    return {
      exceeded: true,
      limit: 'tokens',
      message: `Usage limit exceeded: ${usage.tokens} tokens in ${window} (limit ${limits.maxTokens}). Try again later.`,
    };
  }
  return { exceeded: false };
}

export const usageQueries: UsageQueries = {
  async usageSince(userId, since) {
    requireConnected();
    const [totals, runs] = await Promise.all([
      UsageRecordModel.aggregate<{ costUsd: number; inputTokens: number; outputTokens: number }>([
        { $match: { userId, createdAt: { $gte: since } } },
        {
          $group: {
            _id: null,
            costUsd: { $sum: '$costUsd' },
            inputTokens: { $sum: '$inputTokens' },
            outputTokens: { $sum: '$outputTokens' },
          },
        },
      ]),
      RunModel.countDocuments({ userId, createdAt: { $gte: since } }),
    ]);
    const summed = totals[0];
    return {
      costUsd: summed?.costUsd ?? 0,
      tokens: (summed?.inputTokens ?? 0) + (summed?.outputTokens ?? 0),
      runs,
    };
  },
};
