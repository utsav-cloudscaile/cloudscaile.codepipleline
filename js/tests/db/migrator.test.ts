import { describe, expect, it } from 'vitest';
import { migrations } from '@/db/migrations/index.js';
import { type Migration, planPending, validateRegistry } from '@/db/migrator.js';

const migration = (id: string): Migration => ({
  id,
  description: `test ${id}`,
  up: async () => {},
});

describe('validateRegistry', () => {
  it('accepts the real registry — the ordering contract every deploy relies on', () => {
    expect(() => validateRegistry(migrations)).not.toThrow();
  });

  it('accepts ascending, well-formed ids', () => {
    expect(() =>
      validateRegistry([migration('0001-first'), migration('0002-second'), migration('0010-gap')]),
    ).not.toThrow();
  });

  it.each([
    ['missing numeric prefix', 'first-thing'],
    ['short prefix', '001-short'],
    ['uppercase', '0002-Bad-Case'],
    ['spaces', '0002-has space'],
  ])('rejects a malformed id (%s)', (_reason, badId) => {
    expect(() => validateRegistry([migration(badId)])).toThrow(/Invalid migration id/);
  });

  it('rejects duplicate ids', () => {
    expect(() => validateRegistry([migration('0001-a'), migration('0001-a')])).toThrow(
      /out of order/,
    );
  });

  it('rejects duplicate prefixes even with different names', () => {
    expect(() => validateRegistry([migration('0001-a'), migration('0001-b')])).toThrow(
      /out of order/,
    );
  });

  it('rejects out-of-order entries', () => {
    expect(() => validateRegistry([migration('0002-later'), migration('0001-earlier')])).toThrow(
      /out of order/,
    );
  });
});

describe('planPending', () => {
  const registry = [migration('0001-a'), migration('0002-b'), migration('0003-c')];

  it('returns everything when nothing is applied', () => {
    expect(planPending(new Set(), registry).map((m) => m.id)).toEqual([
      '0001-a',
      '0002-b',
      '0003-c',
    ]);
  });

  it('skips applied migrations, preserving registry order', () => {
    expect(planPending(new Set(['0001-a', '0003-c']), registry).map((m) => m.id)).toEqual([
      '0002-b',
    ]);
  });

  it('returns [] when everything is applied', () => {
    expect(planPending(new Set(['0001-a', '0002-b', '0003-c']), registry)).toEqual([]);
  });
});
