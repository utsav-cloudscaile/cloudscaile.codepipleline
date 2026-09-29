/**
 * Pure helpers that pull the queryable facets out of an SDKMessage before it
 * is persisted (src/db/recorder.ts). Kept side-effect-free and separate from
 * the recorder so they're unit-testable without a MongoDB connection — same
 * split as `resolveLoggerOptions` vs `createLogger` (src/logger).
 *
 * Content blocks are inspected structurally (guarded property checks) rather
 * than through the SDK's Beta* types: the persisted `payload` keeps full
 * fidelity anyway, so these only need to be right about the handful of
 * fields the DB indexes, and must not throw on message shapes a newer SDK
 * adds.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface ExtractedToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ExtractedToolResult {
  toolUseId: string;
  content: unknown;
  isError: boolean;
}

/** Queryable facets of one SDK message; `undefined` fields are simply not stored. */
export interface MessageFacets {
  subtype?: string;
  role?: string;
  model?: string;
  parentToolUseId?: string;
  uuid?: string;
  text?: string;
  toolUses: ExtractedToolUse[];
  toolResults: ExtractedToolResult[];
  usage?: unknown;
  timestamp?: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter(isRecord);
}

function textFromBlocks(blocks: Record<string, unknown>[]): string | undefined {
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  return text.length > 0 ? text : undefined;
}

export function extractToolUses(message: SDKMessage): ExtractedToolUse[] {
  if (message.type !== 'assistant') {
    return [];
  }
  return contentBlocks(message.message).flatMap((block) => {
    if (block.type !== 'tool_use' || typeof block.id !== 'string') {
      return [];
    }
    return [
      {
        toolUseId: block.id,
        name: typeof block.name === 'string' ? block.name : 'unknown',
        input: isRecord(block.input) ? block.input : {},
      },
    ];
  });
}

export function extractToolResults(message: SDKMessage): ExtractedToolResult[] {
  if (message.type !== 'user') {
    return [];
  }
  return contentBlocks(message.message).flatMap((block) => {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
      return [];
    }
    return [
      {
        toolUseId: block.tool_use_id,
        content: block.content,
        isError: block.is_error === true,
      },
    ];
  });
}

/** Extracts the queryable facets of `message` in one pass. */
export function extractMessageFacets(message: SDKMessage): MessageFacets {
  const record = message as unknown as Record<string, unknown>;
  const facets: MessageFacets = {
    toolUses: extractToolUses(message),
    toolResults: extractToolResults(message),
  };

  if (typeof record.subtype === 'string') {
    facets.subtype = record.subtype;
  }
  if (typeof record.uuid === 'string') {
    facets.uuid = record.uuid;
  }
  if (typeof record.parent_tool_use_id === 'string') {
    facets.parentToolUseId = record.parent_tool_use_id;
  }
  if (typeof record.timestamp === 'string') {
    const parsed = new Date(record.timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      facets.timestamp = parsed;
    }
  }

  if (message.type === 'assistant') {
    facets.role = 'assistant';
    const text = textFromBlocks(contentBlocks(message.message));
    if (text !== undefined) {
      facets.text = text;
    }
    if (isRecord(message.message)) {
      if (typeof message.message.model === 'string') {
        facets.model = message.message.model;
      }
      facets.usage = message.message.usage;
    }
  } else if (message.type === 'user') {
    facets.role = 'user';
    const content = isRecord(message.message) ? message.message.content : undefined;
    const text =
      typeof content === 'string' ? content : textFromBlocks(contentBlocks(message.message));
    if (text !== undefined) {
      facets.text = text;
    }
  } else if (message.type === 'result') {
    facets.usage = message.usage;
    if (message.subtype === 'success') {
      facets.text = message.result;
    }
  }

  return facets;
}

/**
 * Coarse grouping so later APIs can answer "what files changed" /
 * "what git operations ran" with an indexed query instead of matching tool
 * names everywhere. The specific tool stays in `name`.
 */
export function toolCategory(name: string): string {
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    return 'file_change';
  }
  if (name.startsWith('mcp__git__')) {
    return 'git';
  }
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') {
    return 'command';
  }
  if (['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].includes(name)) {
    return 'read';
  }
  if (name.startsWith('mcp__')) {
    return 'mcp';
  }
  return 'other';
}

/**
 * Conversation title derived from the caller's prompt: first non-empty line,
 * capped at 80 chars. The Agent SDK auto-generates its own session title (and
 * accepts a `title` option on query()), but never emits it on the message
 * stream — so the DB derives one the same way most chat apps do.
 */
export function deriveTitle(prompt: string, maxLength = 80): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return 'Untitled run';
  }
  return firstLine.length <= maxLength ? firstLine : `${firstLine.slice(0, maxLength - 1)}…`;
}

/** Flat token/cost rollup mapped from an SDK result message. */
export interface UsageTotals {
  costUsd: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function usageTotalsFromResult(
  message: Extract<SDKMessage, { type: 'result' }>,
): UsageTotals {
  const usage = (isRecord(message.usage) ? message.usage : {}) as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
  return {
    costUsd: num(message.total_cost_usd),
    numTurns: num(message.num_turns),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadInputTokens: num(usage.cache_read_input_tokens),
    cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
  };
}
