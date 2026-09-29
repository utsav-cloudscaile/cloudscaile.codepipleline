import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@/config/index.js';
import { buildMcpServers } from '@/mcp/index.js';

const baseConfig: AppConfig = {
  policyPath: './pipeline.policy.json',
  policy: {},
  logLevel: 'info',
  model: 'claude-haiku-4-5-20251001',
  git: {
    token: 'test-token',
    email: 'automation@example.com',
    name: 'Automation Bot',
  },
  trigger: { port: 3000, host: '127.0.0.1' },
  usageLimits: { windowHours: 24 },
  mongo: { uri: 'mongodb://localhost:27017/test', autoMigrate: true },
};

describe('buildMcpServers', () => {
  it('sets both author and committer identity for the git server', () => {
    const servers = buildMcpServers(baseConfig);

    expect(servers.git?.env).toMatchObject({
      GIT_AUTHOR_NAME: 'Automation Bot',
      GIT_AUTHOR_EMAIL: 'automation@example.com',
      GIT_COMMITTER_NAME: 'Automation Bot',
      GIT_COMMITTER_EMAIL: 'automation@example.com',
    });
  });
});
