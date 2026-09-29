/**
 * MCP server registry: wiring for the external platform(s) whose
 * configuration this pipeline updates. These feed into the Agent SDK's
 * `mcpServers` query option.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@/config/index.js';
import { WORKSPACE_ROOT } from './git/workspace.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpServerRegistry = Record<string, McpServerConfig>;

// This module lives at src/mcp/index.ts (dev, run via tsx) or
// dist/mcp/index.js (prod, run via node) — both two levels under the repo
// root, so this resolves to <root>/node_modules/@cyanheads/git-mcp-server/dist/index.js
// in either case. Deliberately *not* `require.resolve`/`import.meta.resolve`:
// the package's `exports` map doesn't expose that subpath (it's meant to be
// run as a CLI, not imported), so package-relative resolution throws
// ERR_PACKAGE_PATH_NOT_EXPORTED — this walks the physical file layout
// instead. Deliberately *not* `npx` either: run from this repo's own
// directory, `npx` reads *our* package.json's `devEngines.packageManager`
// (pnpm-only) and refuses to run under plain npm, even for an already
// locally-installed dependency.
const GIT_MCP_SERVER_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/@cyanheads/git-mcp-server/dist/index.js',
);

/**
 * Builds the MCP server registry for a run. A function rather than a static
 * export because the `git` server needs the validated git identity
 * (`AppConfig['git']`) from `loadAppConfig` (src/config) — see
 * `.claude/skills/add-mcp-server/SKILL.md` for the registration pattern this
 * follows, and `src/mcp/git/workspace.ts` for the pure helpers the trigger
 * server (src/server) uses to compute clone destinations and authenticated
 * URLs before calling into this server's tools.
 *
 * `@cyanheads/git-mcp-server` is a real, exact-pinned `package.json`
 * dependency (not `npx -y <pkg>@latest`) — it gets a real `GIT_TOKEN`-derived
 * credential in its environment and shells out to git on our behalf, so
 * fetching an unpinned version from the registry at run time isn't
 * acceptable. Bump the pinned version deliberately via `pnpm add -E`.
 */
export function buildMcpServers(config: AppConfig): McpServerRegistry {
  return {
    git: {
      command: 'node',
      args: [GIT_MCP_SERVER_ENTRY],
      env: {
        GIT_AUTHOR_NAME: config.git.name,
        GIT_AUTHOR_EMAIL: config.git.email,
        // Git requires a committer identity independent of the author one —
        // without these, `git commit` falls back to `user.name`/`user.email`
        // config (unset in a fresh clone/container) and then system GECOS
        // info (also unset in the runtime image), failing with "empty ident
        // name" regardless of any per-call `author` param passed to the
        // git_commit MCP tool.
        GIT_COMMITTER_NAME: config.git.name,
        GIT_COMMITTER_EMAIL: config.git.email,
        // Restricts every git tool call to this directory tree — defense in
        // depth beyond the guardrail policy (see src/mcp/git/workspace.ts).
        GIT_BASE_DIR: WORKSPACE_ROOT,
      },
    },
  };
}
