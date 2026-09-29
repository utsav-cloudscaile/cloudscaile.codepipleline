import type { CanUseTool, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { evaluateTool, type PolicyConfig } from '@/guardrails/index.js';
import type { McpServerRegistry } from '@/mcp/index.js';
import { loadMasterContext } from './masterContext.js';

export { formatRepoInstructions, type RepoInstructionContent } from './repoInstructions.js';

/** A single named step in the codebase-update pipeline. */
export interface PipelineStage {
  name: string;
  /** Prompt or skill invocation driving this stage. */
  prompt: string;
  /** Working directory this stage's tool calls run against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Session ID to resume (see the Agent SDK's `query()` `resume` option) — continues that session's history instead of starting fresh. */
  resume?: string;
  /** Extra directories (absolute paths) the agent can access beyond `cwd` — passed straight through to the Agent SDK's `additionalDirectories` option. */
  additionalDirectories?: string[];
  /**
   * Extra, already-formatted system-prompt content appended after the master
   * context — e.g. XML-tagged per-repo instructions from the
   * /v1/repo-instructions CRUD API (see formatRepoInstructions,
   * ./repoInstructions.ts). Pipeline stays DB-agnostic: the caller (the
   * trigger route) fetches and formats this, this module only concatenates it.
   */
  additionalContext?: string;
}

export interface PipelineOptions {
  stages: PipelineStage[];
  policy: PolicyConfig;
  mcpServers: McpServerRegistry;
  /** Directory holding INSTRUCTIONS.md/skills prepended to every stage. Defaults to 'master'. */
  masterDir?: string;
  /** Model id passed straight through to query()'s `model` option. Omitted falls back to the CLI default. */
  model?: string;
  /**
   * Consulted for tools the policy marks `'approval-required'` (see
   * `evaluateTool`, src/guardrails/policy.ts). Defaults to always denying —
   * there's no external approval channel wired up yet, so an
   * approval-required tool call fails closed rather than silently proceeding.
   * A caller with a real sign-off mechanism (human-in-the-loop, an approval
   * service) injects one here instead of changing this module.
   */
  approvalHandler?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
  /**
   * Called for every SDK message as it streams in, before the stage
   * completes. Lets a caller (e.g. the trigger server) forward progress
   * live instead of waiting for the final `result` message.
   */
  onMessage?: (stage: string, message: SDKMessage) => void;
}

export interface PipelineStageResult {
  stage: string;
  ok: boolean;
  numTurns: number;
  totalCostUsd: number;
  /** Final assistant result text on success, or a short failure description. */
  summary: string;
  errors: string[];
  /** Session ID this stage ran under — pass back as `PipelineStage.resume` to continue it. */
  sessionId: string;
}

export type PipelineResult = PipelineStageResult[];

/**
 * Runs each stage's prompt through the Agent SDK's `query()`, translating
 * `policy` into `allowedTools`/`disallowedTools` (passed straight through as
 * a coarse pre-filter — since policy entries can use Claude Code's own
 * permission-rule syntax, e.g. `"Bash(npm *)"`, this lets the SDK's own
 * matcher apply it too) and enforcing the policy authoritatively through
 * `canUseTool`, which is called for every tool attempt regardless of the
 * coarse filter above. `canUseTool` MUST be the real deny-by-default gate,
 * not just an approval-required overlay: returning `{behavior:'allow'}` for
 * anything `evaluateTool` doesn't explicitly approve defeats deny-by-default
 * (a prior version of this file did exactly that — it let the model run
 * arbitrary `Bash` commands, including plain `git`, because canUseTool
 * unconditionally allowed anything that wasn't `'approval-required'`,
 * regardless of `allowedTools`) — see `.claude/skills/add-pipeline-stage/SKILL.md`.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const masterContext = await loadMasterContext(options.masterDir);
  const results: PipelineStageResult[] = [];
  for (const stage of options.stages) {
    results.push(await runStage(stage, options, masterContext));
  }
  return results;
}

function buildCanUseTool(options: PipelineOptions): CanUseTool {
  const { policy, approvalHandler } = options;
  return async (toolName, input): Promise<PermissionResult> => {
    const decision = evaluateTool(policy, toolName, input);
    if (decision === 'deny') {
      return { behavior: 'deny', message: `'${toolName}' is denied by the guardrail policy.` };
    }
    if (decision === 'approval-required') {
      const approved = approvalHandler ? await approvalHandler(toolName, input) : false;
      if (!approved) {
        return {
          behavior: 'deny',
          message: `'${toolName}' requires out-of-band approval, which was not granted for this run.`,
        };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

/**
 * Joins the repo-agnostic master context with this stage's already-formatted
 * additionalContext (e.g. XML-tagged repo instructions), skipping either side
 * when empty so a stage with no additionalContext behaves exactly as before
 * this option existed.
 */
function buildSystemPromptAppend(masterContext: string, stage: PipelineStage): string {
  return [masterContext, stage.additionalContext].filter(Boolean).join('\n\n---\n\n');
}

async function runStage(
  stage: PipelineStage,
  options: PipelineOptions,
  masterContext: string,
): Promise<PipelineStageResult> {
  const systemPromptAppend = buildSystemPromptAppend(masterContext, stage);
  const run = query({
    prompt: stage.prompt,
    options: {
      mcpServers: options.mcpServers,
      allowedTools: options.policy.allowedTools,
      disallowedTools: options.policy.deniedTools,
      permissionMode: options.policy.permissionMode,
      canUseTool: buildCanUseTool(options),
      ...(options.model !== undefined && { model: options.model }),
      ...(stage.cwd !== undefined && { cwd: stage.cwd }),
      ...(stage.resume !== undefined && { resume: stage.resume }),
      ...(stage.additionalDirectories !== undefined && {
        additionalDirectories: stage.additionalDirectories,
      }),
      systemPrompt: systemPromptAppend
        ? { type: 'preset', preset: 'claude_code', append: systemPromptAppend }
        : { type: 'preset', preset: 'claude_code' },
    },
  });

  const result: PipelineStageResult = {
    stage: stage.name,
    ok: false,
    numTurns: 0,
    totalCostUsd: 0,
    summary: '',
    errors: [],
    sessionId: stage.resume ?? '',
  };

  for await (const message of run) {
    options.onMessage?.(stage.name, message);
    result.sessionId = message.session_id ?? result.sessionId;
    if (message.type !== 'result') {
      continue;
    }
    result.numTurns = message.num_turns;
    result.totalCostUsd = message.total_cost_usd;
    result.ok = !message.is_error;
    if (message.subtype === 'success') {
      result.summary = message.result;
    } else {
      result.errors = message.errors;
      result.summary = `Stage failed (${message.subtype})`;
    }
  }

  return result;
}
