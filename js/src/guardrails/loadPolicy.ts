/**
 * Reads the on-disk guardrail policy override file (pipeline.policy.json,
 * gitignored — see pipeline.policy.example.json) and merges it over a base
 * policy via resolvePolicy. Kept separate from policy.ts so the pure
 * resolvePolicy/evaluateTool logic stays filesystem-free and independently
 * testable, per this repo's guardrails-are-policy-not-code convention.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DEFAULT_POLICY, type PolicyConfig, resolvePolicy } from './policy.js';

const policyFileSchema = z.object({
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  requireApproval: z.array(z.string()).optional(),
});

/**
 * Loads `policyPath`, validates its shape, and merges it over `base` (default
 * `DEFAULT_POLICY`) via `resolvePolicy`. Unknown top-level keys (e.g. the
 * `$comment*` documentation entries in pipeline.policy.example.json) are
 * ignored, not rejected.
 */
export async function loadPolicy(
  policyPath: string,
  base: PolicyConfig = DEFAULT_POLICY,
): Promise<PolicyConfig> {
  let raw: string;
  try {
    raw = await readFile(policyPath, 'utf-8');
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No guardrail policy file at "${policyPath}". Copy pipeline.policy.example.json to ` +
          'pipeline.policy.json (or point PIPELINE_POLICY_PATH elsewhere) and adjust it for this environment.',
      );
    }
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Guardrail policy file "${policyPath}" is not valid JSON: ${(error as Error).message}`,
    );
  }

  const parsed = policyFileSchema.parse(json);
  // Built up field-by-field (rather than spreading `parsed` directly):
  // zod's `.optional()` types a missing key as `T | undefined`, which
  // conflicts with `Partial<PolicyConfig>` under `exactOptionalPropertyTypes`
  // — that flag distinguishes "key absent" from "key present but undefined".
  const overrides: Partial<PolicyConfig> = {};
  if (parsed.permissionMode !== undefined) {
    overrides.permissionMode = parsed.permissionMode;
  }
  if (parsed.allowedTools !== undefined) {
    overrides.allowedTools = parsed.allowedTools;
  }
  if (parsed.deniedTools !== undefined) {
    overrides.deniedTools = parsed.deniedTools;
  }
  if (parsed.requireApproval !== undefined) {
    overrides.requireApproval = parsed.requireApproval;
  }
  return resolvePolicy(base, overrides);
}
