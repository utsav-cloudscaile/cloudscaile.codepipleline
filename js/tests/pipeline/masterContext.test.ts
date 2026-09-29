import { describe, expect, it } from 'vitest';
import { loadMasterContext } from '@/pipeline/masterContext.js';

describe('loadMasterContext', () => {
  it('concatenates INSTRUCTIONS.md and every skill, alphabetically by skill dir', async () => {
    const context = await loadMasterContext('tests/fixtures/master');

    expect(context).toContain('Fixture baseline instructions.');
    expect(context).toContain('Bar skill body.');
    expect(context).toContain('Foo skill body.');

    const barIndex = context.indexOf('Bar skill body.');
    const fooIndex = context.indexOf('Foo skill body.');
    const instructionsIndex = context.indexOf('Fixture baseline instructions.');
    expect(instructionsIndex).toBeLessThan(barIndex);
    expect(barIndex).toBeLessThan(fooIndex);
  });

  it('returns an empty string when the directory has neither instructions nor skills', async () => {
    const context = await loadMasterContext('tests/fixtures/master-empty');
    expect(context).toBe('');
  });

  it('returns an empty string when masterDir does not exist at all', async () => {
    const context = await loadMasterContext('tests/fixtures/does-not-exist');
    expect(context).toBe('');
  });
});
