/**
 * Guardrail policy: the configurable rules governing which tools (including
 * MCP tools that mutate the target platform's configuration) the pipeline is
 * permitted to invoke, and under what permission mode.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface PolicyConfig {
  /** Permission mode passed through to the Agent SDK query options. */
  permissionMode: PermissionMode;
  /**
   * Tool-name glob patterns that are permitted. MCP tools use the
   * `mcp__<server>__<tool>` naming convention, e.g. `mcp__platform__get_*`.
   */
  allowedTools: string[];
  /** Tool-name glob patterns that are always blocked, regardless of allowedTools. */
  deniedTools: string[];
  /**
   * Tool-name glob patterns that must be approved out-of-band (human-in-the-loop
   * or an external policy service) even when otherwise allowed.
   */
  requireApproval: string[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  permissionMode: 'default',
  allowedTools: [],
  deniedTools: [],
  requireApproval: [],
};

/**
 * Merges a base policy with overrides. Scalars are replaced when present in
 * overrides; array fields are unioned and de-duplicated so overrides can only
 * add restrictions/permissions, never silently drop entries from the base.
 */
export function resolvePolicy(base: PolicyConfig, overrides: Partial<PolicyConfig>): PolicyConfig {
  return {
    permissionMode: overrides.permissionMode ?? base.permissionMode,
    allowedTools: mergeUnique(base.allowedTools, overrides.allowedTools),
    deniedTools: mergeUnique(base.deniedTools, overrides.deniedTools),
    requireApproval: mergeUnique(base.requireApproval, overrides.requireApproval),
  };
}

function mergeUnique(base: string[], extra: string[] | undefined): string[] {
  return Array.from(new Set([...base, ...(extra ?? [])]));
}

/** Converts a `*`-wildcard glob pattern into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 's');
}

/**
 * Matches one policy pattern against a tool call. A bare pattern (e.g.
 * `"mcp__platform__get_*"`) is a glob over `toolName` alone, as before. A
 * `"Tool(content-pattern)"` pattern (Claude Code's own permission-rule
 * syntax, e.g. `"Bash(npm *)"`) additionally requires `toolName` to match
 * `Tool` exactly and, for `Bash` specifically, `input.command` to match
 * `content-pattern` — that's the only parameterized tool this policy model
 * currently understands; a parameterized pattern for any other tool never
 * matches (fails closed rather than guessing which input field to check).
 */
function matchesPattern(
  pattern: string,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const parameterized = /^([^()]+)\((.*)\)$/s.exec(pattern);
  if (!parameterized) {
    return globToRegExp(pattern).test(toolName);
  }
  const ruleTool = parameterized[1];
  const ruleContent = parameterized[2];
  if (ruleTool === undefined || ruleContent === undefined || ruleTool !== toolName) {
    return false;
  }
  if (toolName !== 'Bash') {
    return false;
  }
  const command = input.command;
  return typeof command === 'string' && globToRegExp(ruleContent).test(command);
}

function matchesAny(patterns: string[], toolName: string, input: Record<string, unknown>): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, toolName, input));
}

export type ToolDecision = 'allow' | 'deny' | 'approval-required';

/**
 * Evaluates a policy against a tool call. Deny always wins over allow;
 * approval-required is checked only for tools that are otherwise allowed.
 * `input` is optional and defaults to `{}` — omit it when checking a plain
 * tool name (e.g. in tests); pass the real tool-call input when evaluating
 * a live call, so `"Tool(content-pattern)"` entries (e.g. `"Bash(npm *)"`)
 * are matched correctly instead of always falling through to `'deny'`.
 */
export function evaluateTool(
  policy: PolicyConfig,
  toolName: string,
  input: Record<string, unknown> = {},
): ToolDecision {
  if (matchesAny(policy.deniedTools, toolName, input)) {
    return 'deny';
  }
  if (!matchesAny(policy.allowedTools, toolName, input)) {
    return 'deny';
  }
  if (matchesAny(policy.requireApproval, toolName, input)) {
    return 'approval-required';
  }
  return 'allow';
}
