import { describe, expect, it } from 'vitest';
import { formatRepoInstructions } from '@/pipeline/repoInstructions.js';

describe('formatRepoInstructions', () => {
  it('returns an empty string for an empty list, so callers omit it from the prompt entirely', () => {
    expect(formatRepoInstructions('https://github.com/acme/widgets.git', [])).toBe('');
  });

  it('wraps a single instruction in a repository_instructions root tagged with the repo, and a named instruction tag', () => {
    const result = formatRepoInstructions('https://github.com/acme/widgets.git', [
      { name: 'testing', content: 'Always run `pnpm test` before committing.' },
    ]);

    expect(result).toContain(
      '<repository_instructions repo="https://github.com/acme/widgets.git">',
    );
    expect(result).toContain('<instruction name="testing">');
    expect(result).toContain('Always run `pnpm test` before committing.');
    expect(result).toContain('</instruction>');
    expect(result).toContain('</repository_instructions>');
  });

  it('emits one instruction tag per entry, preserving caller order', () => {
    const result = formatRepoInstructions('https://github.com/acme/widgets.git', [
      { name: 'first', content: 'First body.' },
      { name: 'second', content: 'Second body.' },
    ]);

    const firstIndex = result.indexOf('name="first"');
    const secondIndex = result.indexOf('name="second"');
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it('escapes XML-significant characters in the name and repo attributes', () => {
    const result = formatRepoInstructions('https://example.com/repo?a=1&b=2', [
      { name: '<script>&"\'', content: 'body' },
    ]);

    expect(result).toContain('repo="https://example.com/repo?a=1&amp;b=2"');
    expect(result).toContain('name="&lt;script&gt;&amp;&quot;&apos;"');
    // The raw special characters never appear unescaped in an attribute value.
    expect(result).not.toContain('name="<script>');
  });

  it('trims trailing/leading whitespace from each instruction body', () => {
    const result = formatRepoInstructions('https://github.com/acme/widgets.git', [
      { name: 'spacey', content: '\n\n  body text  \n\n' },
    ]);
    expect(result).toContain('<instruction name="spacey">\nbody text\n</instruction>');
  });
});
