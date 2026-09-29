import { describe, expect, it } from 'vitest';
import { repoSlug, withTokenAuth, workspaceDir } from '@/mcp/git/workspace.js';

describe('repoSlug', () => {
  it('derives a filesystem-safe slug from an https repo URL', () => {
    expect(repoSlug('https://github.com/Cloudscaile-Experience/test-code-pipeline.git')).toBe(
      'cloudscaile-experience-test-code-pipeline',
    );
  });

  it('handles URLs without a .git suffix', () => {
    expect(repoSlug('https://github.com/acme/widgets')).toBe('acme-widgets');
  });

  it('throws when the URL has no path to slugify', () => {
    expect(() => repoSlug('https://github.com')).toThrow(/could not derive/i);
  });
});

describe('workspaceDir', () => {
  it('joins the root and the derived slug', () => {
    expect(workspaceDir('/tmp/workspaces', 'https://github.com/acme/widgets.git')).toBe(
      '/tmp/workspaces/acme-widgets',
    );
  });
});

describe('withTokenAuth', () => {
  it('embeds the token as the URL userinfo', () => {
    expect(withTokenAuth('https://github.com/acme/widgets.git', 'shh')).toBe(
      'https://x-access-token:shh@github.com/acme/widgets.git',
    );
  });

  it('rejects non-http(s) URLs', () => {
    expect(() => withTokenAuth('git@github.com:acme/widgets.git', 'shh')).toThrow();
  });
});
