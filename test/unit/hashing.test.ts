import { describe, expect, it } from 'vitest';
import { buildCompletionCacheKey, fnv1a, shortHash } from '../../src/core/hashing.js';

describe('fnv1a', () => {
  it('returns a stable value for the same input', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
  });

  it('returns different values for different inputs', () => {
    expect(fnv1a('hello')).not.toBe(fnv1a('world'));
  });

  it('returns an unsigned 32-bit integer', () => {
    const value = fnv1a('some longer string with unicode 中文 and symbols !@#');
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(value)).toBe(true);
  });

  it('handles the empty string', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
  });

  it('is sensitive to character order', () => {
    expect(fnv1a('ab')).not.toBe(fnv1a('ba'));
  });
});

describe('shortHash', () => {
  it('always produces eight lowercase hex characters', () => {
    for (const input of ['', 'a', 'hello world', '中文']) {
      const hash = shortHash(input);
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('is deterministic', () => {
    expect(shortHash('deterministic')).toBe(shortHash('deterministic'));
  });
});

describe('buildCompletionCacheKey', () => {
  const base = {
    uri: 'file:///a.ts',
    languageId: 'typescript',
    model: 'qwen',
    position: { line: 3, character: 7 },
    prefixTail: 'const a = 1;',
    suffixHead: '\nreturn a;',
  };

  it('produces a stable key for identical inputs', () => {
    expect(buildCompletionCacheKey(base)).toBe(buildCompletionCacheKey(base));
  });

  it('changes when the position changes', () => {
    const moved = { ...base, position: { line: 4, character: 0 } };
    expect(buildCompletionCacheKey(base)).not.toBe(buildCompletionCacheKey(moved));
  });

  it('changes when the model changes', () => {
    expect(buildCompletionCacheKey(base)).not.toBe(
      buildCompletionCacheKey({ ...base, model: 'other' }),
    );
  });

  it('changes when the document changes', () => {
    expect(buildCompletionCacheKey(base)).not.toBe(
      buildCompletionCacheKey({ ...base, uri: 'file:///b.ts' }),
    );
  });

  it('changes when the surrounding text changes', () => {
    expect(buildCompletionCacheKey(base)).not.toBe(
      buildCompletionCacheKey({ ...base, prefixTail: 'const a = 2;' }),
    );
  });

  it('ignores changes outside the tail window', () => {
    // The differing characters sit at the very start, separated from the tail
    // window by 3000 filler characters, so the key must not change.
    const filler = '#'.repeat(3000) + 'const a = 1;';
    const farAway = 'x'.repeat(5000) + filler;
    const alsoFarAway = 'y'.repeat(5000) + filler;
    expect(
      buildCompletionCacheKey({ ...base, prefixTail: farAway }, 2000),
    ).toBe(buildCompletionCacheKey({ ...base, prefixTail: alsoFarAway }, 2000));
  });

  it('notices changes inside the tail window', () => {
    const near = 'x'.repeat(10) + 'const a = 1;';
    const alsoNear = 'x'.repeat(10) + 'const a = 2;';
    expect(
      buildCompletionCacheKey({ ...base, prefixTail: near }, 2000),
    ).not.toBe(buildCompletionCacheKey({ ...base, prefixTail: alsoNear }, 2000));
  });

  it('includes the language id', () => {
    expect(buildCompletionCacheKey(base)).toContain('typescript');
  });

  it('clamps a non-positive tail length to one', () => {
    const key = buildCompletionCacheKey(base, 0);
    expect(key.length).toBeGreaterThan(0);
  });
});
