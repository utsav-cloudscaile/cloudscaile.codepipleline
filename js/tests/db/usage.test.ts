import { describe, expect, it } from 'vitest';
import {
  evaluateUsageLimits,
  type UsageLimitsConfig,
  type UsageWindow,
  usageLimitsActive,
} from '@/db/usage.js';

const noUsage: UsageWindow = { costUsd: 0, tokens: 0, runs: 0 };

describe('usageLimitsActive', () => {
  it('is false when only the window is configured (no max set)', () => {
    expect(usageLimitsActive({ windowHours: 24 })).toBe(false);
  });

  it.each([
    { maxCostUsd: 5 },
    { maxTokens: 100_000 },
    { maxRuns: 10 },
  ] as Partial<UsageLimitsConfig>[])('is true when any limit is set: %o', (partial) => {
    expect(usageLimitsActive({ windowHours: 24, ...partial })).toBe(true);
  });
});

describe('evaluateUsageLimits', () => {
  it('passes when no limit is configured, whatever the usage', () => {
    const usage: UsageWindow = { costUsd: 1e9, tokens: 1e9, runs: 1e9 };
    expect(evaluateUsageLimits({ windowHours: 24 }, usage)).toEqual({ exceeded: false });
  });

  it('passes when usage is below every configured limit', () => {
    const limits: UsageLimitsConfig = {
      windowHours: 24,
      maxCostUsd: 5,
      maxTokens: 100_000,
      maxRuns: 10,
    };
    const usage: UsageWindow = { costUsd: 4.99, tokens: 99_999, runs: 9 };
    expect(evaluateUsageLimits(limits, usage)).toEqual({ exceeded: false });
  });

  it('denies at exactly the limit (>=), not only past it', () => {
    const verdict = evaluateUsageLimits({ windowHours: 24, maxRuns: 10 }, { ...noUsage, runs: 10 });
    expect(verdict.exceeded).toBe(true);
  });

  it('reports the cost limit with the window and both amounts in the message', () => {
    const verdict = evaluateUsageLimits(
      { windowHours: 12, maxCostUsd: 5 },
      { ...noUsage, costUsd: 7.512345 },
    );
    expect(verdict).toMatchObject({ exceeded: true, limit: 'costUsd' });
    expect(verdict.exceeded && verdict.message).toContain('$7.51');
    expect(verdict.exceeded && verdict.message).toContain('$5');
    expect(verdict.exceeded && verdict.message).toContain('12h');
  });

  it('reports the token limit', () => {
    const verdict = evaluateUsageLimits(
      { windowHours: 24, maxTokens: 100_000 },
      { ...noUsage, tokens: 150_000 },
    );
    expect(verdict).toMatchObject({ exceeded: true, limit: 'tokens' });
  });

  it('reports the run limit', () => {
    const verdict = evaluateUsageLimits({ windowHours: 24, maxRuns: 10 }, { ...noUsage, runs: 11 });
    expect(verdict).toMatchObject({ exceeded: true, limit: 'runs' });
  });

  it('ignores dimensions whose limit is unset even when their usage is huge', () => {
    const verdict = evaluateUsageLimits(
      { windowHours: 24, maxRuns: 10 },
      { costUsd: 1e9, tokens: 1e9, runs: 1 },
    );
    expect(verdict).toEqual({ exceeded: false });
  });
});
