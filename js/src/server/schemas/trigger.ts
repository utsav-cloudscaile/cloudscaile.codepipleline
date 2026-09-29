import { z } from 'zod';

// z.strictObject (not z.object): a plain z.object silently strips unknown
// keys instead of rejecting them, so a typo'd or unsupported field (e.g. a
// caller misremembering a field name, or probing for one) would otherwise
// be accepted with no signal at all. Strict makes an unrecognized key a 400
// VALIDATION_ERROR like any other malformed field, on this route and its
// nested refDirs entries alike.
export const triggerBodySchema = z.strictObject({
  prompt: z
    .string()
    .min(1, 'prompt is required')
    .describe('The change to make in the target repo.'),
  repoUrl: z
    .url('repoUrl must be a valid URL')
    .min(1, 'repoUrl is required')
    .describe('Repo to clone/pull and push to.'),
  sessionId: z
    .uuid('sessionId must be a valid UUID')
    .optional()
    .describe(
      "Resume the session with this ID (returned as `sessionId` on a previous run's " +
        '`done` event) instead of starting a new conversation.',
    ),
  dir: z
    .string()
    .min(1, 'dir must not be empty')
    .optional()
    .describe(
      'Relative path within the repo to scope the agent to. Must already exist in the ' +
        'cloned repo — the request fails otherwise.',
    ),
  refDirs: z
    .array(
      z.strictObject({
        path: z.string().min(1, 'refDirs[].path must not be empty'),
      }),
    )
    .optional()
    .describe(
      'Extra directories (relative to the repo root) the agent can read/write beyond `dir`, ' +
        "passed through as the Agent SDK's `additionalDirectories` option — useful for giving " +
        'a `dir`-scoped run visibility into e.g. a shared package. Each must already exist in ' +
        'the cloned repo — the request fails otherwise.',
    ),
});
