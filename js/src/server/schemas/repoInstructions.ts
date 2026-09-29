/**
 * Zod contracts for the /v1/repo-instructions CRUD API — per-repo (not
 * per-caller) named instruction blocks that /v1/trigger layers into a
 * stage's system prompt (see src/pipeline/repoInstructions.ts). The response
 * schema mirrors the `RepoInstructionDTO` interface in
 * src/db/repoInstructions.ts (the source of truth for the wire shape) — the
 * `satisfies z.ZodType<...>` check keeps the two from drifting, same pattern
 * as schemas/sessions.ts.
 */
import { z } from 'zod';
import type { RepoInstructionDTO } from '@/db/index.js';
import { paginationQuerySchema } from './common.js';

/**
 * Readable-but-constrained: this becomes an XML attribute value (escaped —
 * see formatRepoInstructions) and the lookup key alongside repoUrl, so it's
 * kept to characters a person would actually type as a short label rather
 * than arbitrary text.
 */
const instructionNameSchema = z
  .string()
  .trim()
  .min(1, 'name is required')
  .max(200, 'name must be at most 200 characters')
  .regex(
    /^[\p{L}\p{N} _.-]+$/u,
    'name may only contain letters, numbers, spaces, dots, hyphens, and underscores',
  );

const instructionContentSchema = z
  .string()
  .min(1, 'content is required')
  .max(50_000, 'content must be at most 50000 characters');

// z.strictObject: an unrecognized field is a 400 VALIDATION_ERROR, not a
// silently-ignored key — same rationale as triggerBodySchema.
export const createRepoInstructionBodySchema = z.strictObject({
  repoUrl: z
    .url('repoUrl must be a valid URL')
    .min(1, 'repoUrl is required')
    .describe('Repo these instructions apply to — matched against /v1/trigger by repo slug.'),
  name: instructionNameSchema.describe(
    'Short label, unique per (caller, repo) — e.g. "testing", "deploy-notes".',
  ),
  content: instructionContentSchema.describe(
    'The instruction text, injected into the pipeline system prompt when this repo is triggered.',
  ),
  enabled: z
    .boolean()
    .optional()
    .default(true)
    .describe('When false, stored but excluded from the system prompt.'),
});

export const updateRepoInstructionBodySchema = z
  .strictObject({
    name: instructionNameSchema.optional(),
    content: instructionContentSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.content !== undefined || body.enabled !== undefined,
    {
      message: 'At least one of name, content, enabled must be provided',
    },
  );

export const repoInstructionParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, 'id must be a 24-character hex ObjectId'),
});

export const repoInstructionQuerySchema = paginationQuerySchema.extend({
  repoUrl: z
    .url('repoUrl must be a valid URL')
    .optional()
    .describe('Narrow the list to instructions for a single repo.'),
});

export const repoInstructionSchema = z
  .object({
    id: z.string(),
    repoUrl: z.string(),
    repoSlug: z.string(),
    name: z.string(),
    content: z.string(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime().optional(),
  })
  .describe('One repo instruction block.') satisfies z.ZodType<RepoInstructionDTO>;
