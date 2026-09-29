import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  deriveTitle,
  extractMessageFacets,
  extractToolResults,
  extractToolUses,
  toolCategory,
  usageTotalsFromResult,
} from '@/db/extract.js';

/** Minimal shapes matching what the Agent SDK streams — cast, since the real types are far wider. */
const assistantMessage = {
  type: 'assistant',
  uuid: 'uuid-assistant-1',
  session_id: 'session-1',
  parent_tool_use_id: null,
  message: {
    model: 'claude-sonnet-5',
    usage: { input_tokens: 10, output_tokens: 20 },
    content: [
      { type: 'text', text: 'Editing the file now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_use', id: 'toolu_2', name: 'mcp__git__git_commit', input: { message: 'fix' } },
    ],
  },
} as unknown as SDKMessage;

const userToolResultMessage = {
  type: 'user',
  session_id: 'session-1',
  parent_tool_use_id: null,
  tool_use_result: { filePath: '/repo/a.ts' },
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }],
  },
} as unknown as SDKMessage;

const resultMessage = {
  type: 'result',
  subtype: 'success',
  uuid: 'uuid-result-1',
  session_id: 'session-1',
  is_error: false,
  num_turns: 4,
  result: 'All done.',
  stop_reason: 'end_turn',
  total_cost_usd: 0.42,
  usage: {
    input_tokens: 100,
    output_tokens: 200,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 50,
  },
} as unknown as Extract<SDKMessage, { type: 'result' }>;

describe('extractToolUses', () => {
  it('pulls every tool_use block out of an assistant message', () => {
    expect(extractToolUses(assistantMessage)).toEqual([
      { toolUseId: 'toolu_1', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { toolUseId: 'toolu_2', name: 'mcp__git__git_commit', input: { message: 'fix' } },
    ]);
  });

  it('returns [] for non-assistant messages', () => {
    expect(extractToolUses(userToolResultMessage)).toEqual([]);
  });
});

describe('extractToolResults', () => {
  it('pulls tool_result blocks with their tool_use_id and error flag', () => {
    expect(extractToolResults(userToolResultMessage)).toEqual([
      { toolUseId: 'toolu_1', content: 'ok', isError: false },
    ]);
  });

  it('returns [] for assistant messages', () => {
    expect(extractToolResults(assistantMessage)).toEqual([]);
  });
});

describe('extractMessageFacets', () => {
  it('extracts role, model, text, usage, and tool uses from an assistant message', () => {
    const facets = extractMessageFacets(assistantMessage);
    expect(facets.role).toBe('assistant');
    expect(facets.model).toBe('claude-sonnet-5');
    expect(facets.text).toBe('Editing the file now.');
    expect(facets.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(facets.uuid).toBe('uuid-assistant-1');
    expect(facets.toolUses).toHaveLength(2);
  });

  it('uses the result text and usage for a result message', () => {
    const facets = extractMessageFacets(resultMessage);
    expect(facets.text).toBe('All done.');
    expect(facets.subtype).toBe('success');
    expect(facets.usage).toBe(resultMessage.usage);
  });

  it('does not throw on message shapes it does not recognize', () => {
    const facets = extractMessageFacets({ type: 'system', subtype: 'init' } as SDKMessage);
    expect(facets.toolUses).toEqual([]);
    expect(facets.subtype).toBe('init');
  });
});

describe('toolCategory', () => {
  it.each([
    ['Edit', 'file_change'],
    ['Write', 'file_change'],
    ['mcp__git__git_commit', 'git'],
    ['mcp__git__git_push', 'git'],
    ['Bash', 'command'],
    ['Read', 'read'],
    ['mcp__other__do_thing', 'mcp'],
    ['Task', 'other'],
  ])('categorizes %s as %s', (name, category) => {
    expect(toolCategory(name)).toBe(category);
  });
});

describe('deriveTitle', () => {
  it('uses the first non-empty line', () => {
    expect(deriveTitle('\n\n  Add a health check route\ndetails below')).toBe(
      'Add a health check route',
    );
  });

  it('truncates long prompts to the max length with an ellipsis', () => {
    const title = deriveTitle('x'.repeat(200));
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back for empty prompts', () => {
    expect(deriveTitle('   \n ')).toBe('Untitled run');
  });
});

describe('usageTotalsFromResult', () => {
  it('maps cost, turns, and token counts from a result message', () => {
    expect(usageTotalsFromResult(resultMessage)).toEqual({
      costUsd: 0.42,
      numTurns: 4,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 50,
    });
  });

  it('defaults missing usage fields to 0', () => {
    const sparse = { ...resultMessage, usage: {} } as Extract<SDKMessage, { type: 'result' }>;
    expect(usageTotalsFromResult(sparse).inputTokens).toBe(0);
  });
});
