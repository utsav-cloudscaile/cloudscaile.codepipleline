import { describe, expect, it } from 'vitest';
import { loadPolicy } from '@/guardrails/loadPolicy.js';
import { DEFAULT_POLICY } from '@/guardrails/policy.js';

describe('loadPolicy', () => {
  it('merges a valid policy file over DEFAULT_POLICY, ignoring unknown keys', async () => {
    const policy = await loadPolicy('tests/fixtures/policy/valid.policy.json');
    expect(policy).toEqual({
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'mcp__git__git_status'],
      deniedTools: ['mcp__git__git_reset'],
      requireApproval: ['mcp__platform__update_config'],
    });
  });

  it('merges over a custom base policy instead of DEFAULT_POLICY', async () => {
    const base = { ...DEFAULT_POLICY, allowedTools: ['Grep'] };
    const policy = await loadPolicy('tests/fixtures/policy/valid.policy.json', base);
    expect(policy.allowedTools).toEqual(['Grep', 'Read', 'mcp__git__git_status']);
  });

  it('throws a helpful error when the file does not exist', async () => {
    await expect(loadPolicy('tests/fixtures/policy/does-not-exist.json')).rejects.toThrow(
      /copy pipeline\.policy\.example\.json/i,
    );
  });

  it('throws a helpful error when the file is not valid JSON', async () => {
    await expect(loadPolicy('tests/fixtures/policy/invalid.policy.json')).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
