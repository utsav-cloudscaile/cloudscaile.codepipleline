import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/config/env.js';

const validEnv = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  GIT_TOKEN: 'ghp_test',
  GIT_EMAIL: 'bot@example.com',
  GIT_NAME: 'Pipeline Bot',
  MONGODB_URI: 'mongodb://localhost:27017/code-pipeline',
};

describe('parseEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = parseEnv(validEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PIPELINE_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(env.PIPELINE_POLICY_PATH).toBe('./pipeline.policy.json');
    expect(env.PIPELINE_LOG_LEVEL).toBe('info');
    expect(env.PORT).toBe(8000);
    expect(env.HOST).toBe('127.0.0.1');
  });

  it('overrides PIPELINE_MODEL from the environment', () => {
    const env = parseEnv({ ...validEnv, PIPELINE_MODEL: 'claude-sonnet-5' });
    expect(env.PIPELINE_MODEL).toBe('claude-sonnet-5');
  });

  it('coerces PORT from a string to a number', () => {
    const env = parseEnv({ ...validEnv, PORT: '4100' });
    expect(env.PORT).toBe(4100);
  });

  it('defaults MONGODB_AUTO_MIGRATE to true and rejects non-boolean values', () => {
    expect(parseEnv(validEnv).MONGODB_AUTO_MIGRATE).toBe('true');
    expect(parseEnv({ ...validEnv, MONGODB_AUTO_MIGRATE: 'false' }).MONGODB_AUTO_MIGRATE).toBe(
      'false',
    );
    expect(() => parseEnv({ ...validEnv, MONGODB_AUTO_MIGRATE: 'yes' })).toThrow(
      /MONGODB_AUTO_MIGRATE/,
    );
  });

  it('leaves MONGODB_DB_NAME undefined when unset, so it cannot shadow the db in the URI', () => {
    const env = parseEnv(validEnv);
    expect(env.MONGODB_DB_NAME).toBeUndefined();
    expect(parseEnv({ ...validEnv, MONGODB_DB_NAME: 'other-db' }).MONGODB_DB_NAME).toBe('other-db');
  });

  it.each(['ANTHROPIC_API_KEY', 'GIT_TOKEN', 'GIT_EMAIL', 'GIT_NAME', 'MONGODB_URI'] as const)(
    'throws naming %s when it is missing',
    (key) => {
      const rest = { ...validEnv };
      delete rest[key];
      expect(() => parseEnv(rest)).toThrow(new RegExp(key));
    },
  );

  it('rejects an invalid GIT_EMAIL', () => {
    expect(() => parseEnv({ ...validEnv, GIT_EMAIL: 'not-an-email' })).toThrow(/GIT_EMAIL/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => parseEnv({ ...validEnv, PORT: '-1' })).toThrow(/PORT/);
  });

  it('defaults the usage-limit window to 24h and leaves every max unset', () => {
    const env = parseEnv(validEnv);
    expect(env.USAGE_LIMIT_WINDOW_HOURS).toBe(24);
    expect(env.USAGE_LIMIT_MAX_COST_USD).toBeUndefined();
    expect(env.USAGE_LIMIT_MAX_TOKENS).toBeUndefined();
    expect(env.USAGE_LIMIT_MAX_RUNS).toBeUndefined();
  });

  it('coerces the usage-limit vars from strings', () => {
    const env = parseEnv({
      ...validEnv,
      USAGE_LIMIT_WINDOW_HOURS: '12',
      USAGE_LIMIT_MAX_COST_USD: '5.50',
      USAGE_LIMIT_MAX_TOKENS: '100000',
      USAGE_LIMIT_MAX_RUNS: '10',
    });
    expect(env.USAGE_LIMIT_WINDOW_HOURS).toBe(12);
    expect(env.USAGE_LIMIT_MAX_COST_USD).toBe(5.5);
    expect(env.USAGE_LIMIT_MAX_TOKENS).toBe(100_000);
    expect(env.USAGE_LIMIT_MAX_RUNS).toBe(10);
  });

  it.each([
    ['USAGE_LIMIT_WINDOW_HOURS', '0'],
    ['USAGE_LIMIT_MAX_COST_USD', '-1'],
    ['USAGE_LIMIT_MAX_TOKENS', '1.5'],
    ['USAGE_LIMIT_MAX_RUNS', '0'],
  ])('rejects an invalid %s=%s', (key, value) => {
    expect(() => parseEnv({ ...validEnv, [key]: value })).toThrow(new RegExp(key));
  });
});
