import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, resolvePolicy } from '@/guardrails/index.js';

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const { runPipeline } = await import('@/pipeline/index.js');

async function* messages(...msgs: Record<string, unknown>[]) {
  for (const msg of msgs) {
    yield msg;
  }
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.05,
    result: 'Done.',
    session_id: 'session-1',
    ...overrides,
  };
}

function errorResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    num_turns: 10,
    total_cost_usd: 0.5,
    errors: ['hit max turns'],
    session_id: 'session-1',
    ...overrides,
  };
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('runPipeline', () => {
  it('maps a successful stage result from the SDK result message', async () => {
    queryMock.mockReturnValue(messages(successResult()));

    const [result] = await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing' }],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
    });

    expect(result).toMatchObject({
      stage: 'demo',
      ok: true,
      numTurns: 3,
      totalCostUsd: 0.05,
      summary: 'Done.',
      errors: [],
      sessionId: 'session-1',
    });
  });

  it('maps a failed stage result and collects errors', async () => {
    queryMock.mockReturnValue(messages(errorResult()));

    const [result] = await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing' }],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
    });

    expect(result).toMatchObject({
      stage: 'demo',
      ok: false,
      numTurns: 10,
      errors: ['hit max turns'],
    });
    expect(result?.summary).toContain('error_max_turns');
  });

  it('passes policy allowedTools/disallowedTools/permissionMode straight through to query()', async () => {
    queryMock.mockReturnValue(messages(successResult()));
    const policy = resolvePolicy(DEFAULT_POLICY, {
      allowedTools: ['mcp__git__git_push'],
      deniedTools: ['mcp__git__git_reset'],
      permissionMode: 'acceptEdits',
    });

    await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing', cwd: '/tmp/workspace' }],
      policy,
      mcpServers: { git: { command: 'npx', args: ['-y', 'git-mcp-server'] } },
      masterDir: 'tests/fixtures/master-empty',
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(options.allowedTools).toEqual(['mcp__git__git_push']);
    expect(options.disallowedTools).toEqual(['mcp__git__git_reset']);
    expect(options.permissionMode).toBe('acceptEdits');
    expect(options.cwd).toBe('/tmp/workspace');
  });

  it('runs stages in order and returns one result per stage', async () => {
    queryMock
      .mockReturnValueOnce(messages(successResult({ result: 'first' })))
      .mockReturnValueOnce(messages(successResult({ result: 'second' })));

    const results = await runPipeline({
      stages: [
        { name: 'one', prompt: 'first prompt' },
        { name: 'two', prompt: 'second prompt' },
      ],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
    });

    expect(results.map((r) => r.stage)).toEqual(['one', 'two']);
    expect(results.map((r) => r.summary)).toEqual(['first', 'second']);
  });

  it('passes stage.resume through to query() as options.resume', async () => {
    queryMock.mockReturnValue(messages(successResult()));

    await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing', resume: 'prior-session' }],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
    });

    const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(options.resume).toBe('prior-session');
  });

  it('omits resume from query() options when the stage does not set it', async () => {
    queryMock.mockReturnValue(messages(successResult()));

    await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing' }],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
    });

    const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(options.resume).toBeUndefined();
  });

  it('passes stage.additionalDirectories through to query() as options.additionalDirectories', async () => {
    queryMock.mockReturnValue(messages(successResult()));

    await runPipeline({
      stages: [
        {
          name: 'demo',
          prompt: 'do the thing',
          additionalDirectories: ['/tmp/workspace/packages/shared'],
        },
      ],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
    });

    const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(options.additionalDirectories).toEqual(['/tmp/workspace/packages/shared']);
  });

  it('omits additionalDirectories from query() options when the stage does not set it', async () => {
    queryMock.mockReturnValue(messages(successResult()));

    await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing' }],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
    });

    const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(options.additionalDirectories).toBeUndefined();
  });

  it('passes options.model through to query() as options.model', async () => {
    queryMock.mockReturnValue(messages(successResult()));

    await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing' }],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
      model: 'claude-haiku-4-5-20251001',
    });

    const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(options.model).toBe('claude-haiku-4-5-20251001');
  });

  it('omits model from query() options when not set, leaving the SDK/CLI default in effect', async () => {
    queryMock.mockReturnValue(messages(successResult()));

    await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing' }],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
    });

    const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(options.model).toBeUndefined();
  });

  it('calls onMessage for every SDK message, including non-result ones, before the stage resolves', async () => {
    const assistantMessage = { type: 'assistant', session_id: 'session-1' };
    queryMock.mockReturnValue(messages(assistantMessage, successResult()));
    const onMessage = vi.fn();

    await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing' }],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
      onMessage,
    });

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, 'demo', assistantMessage);
    expect(onMessage).toHaveBeenNthCalledWith(2, 'demo', successResult());
  });

  it('falls back to the resumed session id when a later message omits session_id', async () => {
    const syntheticUserMessage = { type: 'user', message: {} };
    queryMock.mockReturnValue(
      messages(syntheticUserMessage, successResult({ session_id: undefined })),
    );

    const [result] = await runPipeline({
      stages: [{ name: 'demo', prompt: 'do the thing', resume: 'prior-session' }],
      policy: DEFAULT_POLICY,
      mcpServers: {},
      masterDir: 'tests/fixtures/master-empty',
    });

    expect(result?.sessionId).toBe('prior-session');
  });

  describe('systemPrompt (master context + target-repo CLAUDE.md/skills wiring)', () => {
    it('uses the bare claude_code preset, with no append key, when the master dir is empty', async () => {
      queryMock.mockReturnValue(messages(successResult()));

      await runPipeline({
        stages: [{ name: 'demo', prompt: 'do the thing' }],
        policy: DEFAULT_POLICY,
        mcpServers: {},
        masterDir: 'tests/fixtures/master-empty',
      });

      const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];
      expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('appends loadMasterContext output (INSTRUCTIONS.md + every skill) to the claude_code preset', async () => {
      queryMock.mockReturnValue(messages(successResult()));

      await runPipeline({
        stages: [{ name: 'demo', prompt: 'do the thing' }],
        policy: DEFAULT_POLICY,
        mcpServers: {},
        masterDir: 'tests/fixtures/master',
      });

      const [{ options }] = queryMock.mock.calls[0] as [
        { options: { systemPrompt: { type: string; preset: string; append?: string } } },
      ];
      expect(options.systemPrompt.type).toBe('preset');
      expect(options.systemPrompt.preset).toBe('claude_code');
      expect(options.systemPrompt.append).toContain('Fixture baseline instructions.');
      expect(options.systemPrompt.append).toContain('Bar skill body.');
      expect(options.systemPrompt.append).toContain('Foo skill body.');
    });

    it('appends stage.additionalContext after the master context, separated from it', async () => {
      queryMock.mockReturnValue(messages(successResult()));

      await runPipeline({
        stages: [
          {
            name: 'demo',
            prompt: 'do the thing',
            additionalContext:
              '<repository_instructions repo="x"><instruction name="a">b</instruction></repository_instructions>',
          },
        ],
        policy: DEFAULT_POLICY,
        mcpServers: {},
        masterDir: 'tests/fixtures/master',
      });

      const [{ options }] = queryMock.mock.calls[0] as [
        { options: { systemPrompt: { append?: string } } },
      ];
      expect(options.systemPrompt.append).toContain('Fixture baseline instructions.');
      expect(options.systemPrompt.append).toContain('<repository_instructions repo="x">');
      // Master context appears before the repo-specific block.
      expect(options.systemPrompt.append?.indexOf('Fixture baseline instructions.')).toBeLessThan(
        options.systemPrompt.append?.indexOf('<repository_instructions') ?? -1,
      );
    });

    it('uses additionalContext alone (no append-key omission) when the master dir is empty', async () => {
      queryMock.mockReturnValue(messages(successResult()));

      await runPipeline({
        stages: [{ name: 'demo', prompt: 'do the thing', additionalContext: '<x>only this</x>' }],
        policy: DEFAULT_POLICY,
        mcpServers: {},
        masterDir: 'tests/fixtures/master-empty',
      });

      const [{ options }] = queryMock.mock.calls[0] as [
        { options: { systemPrompt: { type: string; preset: string; append?: string } } },
      ];
      expect(options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: '<x>only this</x>',
      });
    });

    // Regression guard: the target repo's own CLAUDE.md and .claude/skills/**
    // are NOT read by our code at all — they're picked up by the SDK itself
    // from `cwd`, and per the SDK's own docs `settingSources` "must include
    // 'project' to load CLAUDE.md files" (omitting the option loads every
    // source, matching CLI defaults). We never set `settingSources` here, so
    // this asserts that stays true: if a future change adds e.g.
    // `settingSources: ['user']` or `strictMcpConfig: true`, it would
    // silently stop the target repo's CLAUDE.md/skills from loading with no
    // other test catching it.
    it('does not set settingSources, leaving the SDK default (load every source, incl. project CLAUDE.md/skills) in effect', async () => {
      queryMock.mockReturnValue(messages(successResult()));

      await runPipeline({
        stages: [{ name: 'demo', prompt: 'do the thing', cwd: '/tmp/target-repo' }],
        policy: DEFAULT_POLICY,
        mcpServers: {},
        masterDir: 'tests/fixtures/master-empty',
      });

      const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];
      expect(options.cwd).toBe('/tmp/target-repo');
      expect(options.settingSources).toBeUndefined();
      expect(options.strictMcpConfig).toBeUndefined();
    });
  });

  describe('canUseTool (deny-by-default + approval-required overlay)', () => {
    async function capturedCanUseTool(
      policyOverrides: Parameters<typeof resolvePolicy>[1],
      approvalHandler?: (name: string, input: object) => boolean,
    ) {
      queryMock.mockReturnValue(messages(successResult()));
      const policy = resolvePolicy(DEFAULT_POLICY, policyOverrides);

      await runPipeline({
        stages: [{ name: 'demo', prompt: 'do the thing' }],
        policy,
        mcpServers: {},
        masterDir: 'tests/fixtures/master-empty',
        ...(approvalHandler !== undefined && { approvalHandler }),
      });

      const [{ options }] = queryMock.mock.calls[0] as [
        { options: { canUseTool: (name: string, input: object, extra: object) => unknown } },
      ];
      return options.canUseTool;
    }

    const approvalPolicy = {
      allowedTools: ['mcp__platform__update_config'],
      requireApproval: ['mcp__platform__update_config'],
    };

    it('denies an approval-required tool by default when no approvalHandler is given', async () => {
      const canUseTool = await capturedCanUseTool(approvalPolicy);
      const decision = await canUseTool('mcp__platform__update_config', {}, {});
      expect(decision).toMatchObject({ behavior: 'deny' });
    });

    it('denies when the approvalHandler declines', async () => {
      const canUseTool = await capturedCanUseTool(approvalPolicy, () => false);
      const decision = await canUseTool('mcp__platform__update_config', {}, {});
      expect(decision).toMatchObject({ behavior: 'deny' });
    });

    it('allows when the approvalHandler approves', async () => {
      const canUseTool = await capturedCanUseTool(approvalPolicy, () => true);
      const decision = await canUseTool('mcp__platform__update_config', {}, {});
      expect(decision).toMatchObject({ behavior: 'allow' });
    });

    it('allows a plain-allowed tool without consulting the handler', async () => {
      const handler = vi.fn(() => false);
      const canUseTool = await capturedCanUseTool(
        {
          allowedTools: ['Read', 'mcp__platform__update_config'],
          requireApproval: ['mcp__platform__update_config'],
        },
        handler,
      );
      const decision = await canUseTool('Read', {}, {});
      expect(decision).toMatchObject({ behavior: 'allow' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('denies a tool that is not matched by allowedTools at all (deny-by-default)', async () => {
      const canUseTool = await capturedCanUseTool({ allowedTools: ['Read'] });
      const decision = await canUseTool('Write', {}, {});
      expect(decision).toMatchObject({ behavior: 'deny' });
    });

    // Regression test for the bug this fix addresses: canUseTool used to
    // unconditionally allow anything that wasn't 'approval-required', which
    // let the model run arbitrary Bash commands (e.g. plain `git`) even
    // though only "Bash(npm *)"-style entries were in allowedTools.
    it('enforces "Bash(content-pattern)" allowedTools entries against the actual command', async () => {
      const canUseTool = await capturedCanUseTool({ allowedTools: ['Bash(npm *)'] });

      const allowed = await canUseTool('Bash', { command: 'npm install mongoose' }, {});
      expect(allowed).toMatchObject({ behavior: 'allow' });

      const denied = await canUseTool('Bash', { command: 'git push origin main' }, {});
      expect(denied).toMatchObject({ behavior: 'deny' });
    });
  });
});
