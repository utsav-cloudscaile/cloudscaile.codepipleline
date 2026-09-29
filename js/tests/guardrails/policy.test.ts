import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, evaluateTool, resolvePolicy } from '@/guardrails/policy.js';

describe('resolvePolicy', () => {
  it('returns the base policy unchanged when there are no overrides', () => {
    const resolved = resolvePolicy(DEFAULT_POLICY, {});
    expect(resolved).toEqual(DEFAULT_POLICY);
  });

  it('unions and de-duplicates array fields instead of replacing them', () => {
    const base = { ...DEFAULT_POLICY, allowedTools: ['mcp__platform__get_*'] };
    const resolved = resolvePolicy(base, {
      allowedTools: ['mcp__platform__get_*', 'mcp__platform__list_*'],
    });
    expect(resolved.allowedTools).toEqual(['mcp__platform__get_*', 'mcp__platform__list_*']);
  });

  it('lets overrides replace scalar fields', () => {
    const resolved = resolvePolicy(DEFAULT_POLICY, { permissionMode: 'plan' });
    expect(resolved.permissionMode).toBe('plan');
  });
});

describe('evaluateTool', () => {
  const policy = resolvePolicy(DEFAULT_POLICY, {
    allowedTools: ['mcp__platform__get_*', 'mcp__platform__update_config'],
    deniedTools: ['mcp__platform__delete_*'],
    requireApproval: ['mcp__platform__update_config'],
  });

  it('denies tools that are not on the allow list', () => {
    expect(evaluateTool(policy, 'mcp__platform__list_users')).toBe('deny');
  });

  it('allows tools matched by an allow glob', () => {
    expect(evaluateTool(policy, 'mcp__platform__get_settings')).toBe('allow');
  });

  it('denies tools on the deny list even if they would match an allow glob', () => {
    const permissive = resolvePolicy(policy, { allowedTools: ['mcp__platform__delete_*'] });
    expect(evaluateTool(permissive, 'mcp__platform__delete_project')).toBe('deny');
  });

  it('flags allowed tools that require out-of-band approval', () => {
    expect(evaluateTool(policy, 'mcp__platform__update_config')).toBe('approval-required');
  });
});

describe('evaluateTool with "Tool(content-pattern)" entries', () => {
  const policy = resolvePolicy(DEFAULT_POLICY, {
    allowedTools: ['Bash(npm *)', 'Bash(pnpm *)'],
    deniedTools: ['Bash(rm -rf*)'],
  });

  it('allows a Bash call whose command matches an allowed content pattern', () => {
    expect(evaluateTool(policy, 'Bash', { command: 'npm install mongoose' })).toBe('allow');
  });

  it('denies a Bash call whose command matches no allowed content pattern', () => {
    expect(evaluateTool(policy, 'Bash', { command: 'git push origin main' })).toBe('deny');
  });

  it('denies a Bash call that matches a denied content pattern even if broadly allowed', () => {
    const permissive = resolvePolicy(policy, { allowedTools: ['Bash(rm *)'] });
    expect(evaluateTool(permissive, 'Bash', { command: 'rm -rf /' })).toBe('deny');
  });

  it('defaults input to {} and denies a parameterized-only policy when no command is given', () => {
    expect(evaluateTool(policy, 'Bash')).toBe('deny');
  });

  it('never matches a parameterized pattern against a different tool name', () => {
    expect(evaluateTool(policy, 'Write', { command: 'npm install' })).toBe('deny');
  });
});
