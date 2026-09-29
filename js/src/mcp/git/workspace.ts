/**
 * Pure helpers for the trigger server (src/server) to decide, before ever
 * invoking the git MCP server, which local directory a given repo maps to
 * and what authenticated URL to hand the agent. Kept dependency-free and
 * side-effect-free so they're unit-testable without touching git or the
 * network — see tests/mcp/git/workspace.test.ts.
 */

import path from 'node:path';

/**
 * Root directory all repo clones live under. Also handed to the git MCP
 * server as `GIT_BASE_DIR` (src/mcp/index.ts) so it refuses to touch
 * anything outside it — defense in depth beyond the guardrail policy, in
 * case a tool call is ever made with an unexpected path. Gitignored; safe to
 * delete between runs.
 */
export const WORKSPACE_ROOT = path.resolve(process.cwd(), 'tmp', 'workspaces');

/**
 * Derives a filesystem-safe slug from a repo URL, e.g.
 * "https://github.com/acme/widgets.git" -> "acme-widgets".
 */
export function repoSlug(repoUrl: string): string {
  const { pathname } = new URL(repoUrl);
  const slug = pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) {
    throw new Error(`Could not derive a workspace slug from repo URL: ${repoUrl}`);
  }
  return slug;
}

/** Joins a workspace root and a repo's slug into its local clone path. */
export function workspaceDir(root: string, repoUrl: string): string {
  return path.join(root, repoSlug(repoUrl));
}

/**
 * Rewrites an HTTPS repo URL to embed a token for authentication, e.g.
 * "https://github.com/acme/widgets.git" + token ->
 * "https://x-access-token:<token>@github.com/acme/widgets.git".
 * The result is only ever held in memory / handed to the git MCP server —
 * never log it.
 */
export function withTokenAuth(repoUrl: string, token: string): string {
  const url = new URL(repoUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Token auth only supports http(s) repo URLs, got: ${url.protocol}`);
  }
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}
