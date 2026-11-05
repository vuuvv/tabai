import { describe, expect, it } from 'vitest';
import {
  jaccard,
  selectNeighborSnippets,
  splitIntoWindows,
  textSimilarity,
  tokenize,
  windowAround,
} from '../../src/completion/similarity.js';

describe('tokenize', () => {
  it('extracts identifiers', () => {
    const tokens = tokenize('const total = calculateTotal(items);');
    expect(tokens.has('total')).toBe(true);
    expect(tokens.has('calculatetotal')).toBe(true);
  });

  it('splits camelCase into components', () => {
    const tokens = tokenize('calculateTotal');
    expect(tokens.has('calculate')).toBe(true);
    expect(tokens.has('total')).toBe(true);
  });

  it('splits snake_case into components', () => {
    const tokens = tokenize('calculate_total');
    expect(tokens.has('calculate')).toBe(true);
    expect(tokens.has('total')).toBe(true);
  });

  it('treats camelCase and snake_case as related', () => {
    // Both yield {calculateTotal, calculate, total} vs {calculate_total,
    // calculate, total}: intersection 2, union 4 -> exactly 0.5.
    const camel = tokenize('calculateTotal');
    const snake = tokenize('calculate_total');
    expect(jaccard(camel, snake)).toBeCloseTo(0.5);
  });

  it('drops very short identifiers', () => {
    const tokens = tokenize('a = b + c;');
    expect(tokens.size).toBe(0);
  });

  it('drops punctuation', () => {
    const tokens = tokenize('(){}[];,.');
    expect(tokens.size).toBe(0);
  });

  it('lower-cases identifiers', () => {
    expect(tokenize('TotalAmount').has('totalamount')).toBe(true);
  });

  it('returns an empty set for empty input', () => {
    expect(tokenize('').size).toBe(0);
  });
});

describe('jaccard', () => {
  it('returns 1 for identical sets', () => {
    const a = new Set(['x', 'y']);
    expect(jaccard(a, new Set(['x', 'y']))).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccard(new Set(['x']), new Set(['y']))).toBe(0);
  });

  it('computes the intersection over union', () => {
    // intersection 1, union 3
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });

  it('returns 0 when either set is empty', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });

  it('is symmetric', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });
});

describe('textSimilarity', () => {
  it('scores identical text as 1', () => {
    expect(textSimilarity('calculate total amount', 'calculate total amount')).toBe(1);
  });

  it('scores unrelated text low', () => {
    expect(textSimilarity('calculate total', 'render viewport')).toBe(0);
  });

  it('scores partially overlapping text between 0 and 1', () => {
    const score = textSimilarity('calculate total amount', 'calculate total price');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe('windowAround', () => {
  const lines = Array.from({ length: 20 }, (_, index) => 'line' + index);

  it('returns the window centred on the line', () => {
    const window = windowAround(lines, 10, 2);
    expect(window.startLine).toBe(8);
    expect(window.text.split('\n')).toHaveLength(5);
  });

  it('clamps at the start of the file', () => {
    const window = windowAround(lines, 0, 3);
    expect(window.startLine).toBe(0);
    expect(window.text.split('\n')).toHaveLength(4);
  });

  it('clamps at the end of the file', () => {
    const window = windowAround(lines, 19, 3);
    expect(window.text.split('\n')).toHaveLength(4);
  });

  it('handles a zero radius', () => {
    const window = windowAround(lines, 5, 0);
    expect(window.text).toBe('line5');
    expect(window.startLine).toBe(5);
  });

  it('handles an empty file', () => {
    expect(() => windowAround([], 0, 5)).not.toThrow();
  });
});

describe('splitIntoWindows', () => {
  it('returns a single window for a short file', () => {
    const windows = splitIntoWindows('a\nb\nc', 10);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.startLine).toBe(0);
  });

  it('produces overlapping windows for a long file', () => {
    const text = Array.from({ length: 100 }, (_, index) => 'l' + index).join('\n');
    const windows = splitIntoWindows(text, 40);
    expect(windows.length).toBeGreaterThan(1);
    // Default stride is half the window, so consecutive windows overlap.
    expect(windows[0]?.startLine).toBe(0);
    expect(windows[1]?.startLine).toBe(20);
  });

  it('honours an explicit stride', () => {
    const text = Array.from({ length: 20 }, (_, index) => 'l' + index).join('\n');
    const windows = splitIntoWindows(text, 5, 5);
    expect(windows.map((w) => w.startLine)).toEqual([0, 5, 10, 15]);
  });

  it('covers the tail of the file', () => {
    const text = Array.from({ length: 20 }, (_, index) => 'l' + index).join('\n');
    const windows = splitIntoWindows(text, 5, 5);
    const last = windows[windows.length - 1];
    expect(last?.text).toContain('l19');
  });

  it('handles an empty string', () => {
    expect(splitIntoWindows('', 10)).toHaveLength(1);
  });

  it('clamps a zero window size to one', () => {
    const windows = splitIntoWindows('a\nb\nc', 0);
    expect(windows.length).toBeGreaterThan(0);
  });
});

describe('selectNeighborSnippets', () => {
  const options = {
    threshold: 0.1,
    maxSnippets: 3,
    maxSnippetChars: 1000,
    maxTotalChars: 2000,
  };

  it('keeps snippets above the threshold, best first', () => {
    const selected = selectNeighborSnippets(
      'calculate total amount',
      [
        { path: 'a.ts', content: 'render viewport width', startLine: 0 },
        { path: 'b.ts', content: 'calculate total amount exactly', startLine: 5 },
      ],
      options,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.path).toBe('b.ts');
    expect(selected[0]?.score).toBeGreaterThan(0);
  });

  it('returns an empty array when nothing matches', () => {
    const selected = selectNeighborSnippets(
      'calculate total',
      [{ path: 'a.ts', content: 'render viewport', startLine: 0 }],
      options,
    );
    expect(selected).toEqual([]);
  });

  it('returns an empty array for an empty query', () => {
    expect(selectNeighborSnippets('', [{ path: 'a.ts', content: 'x', startLine: 0 }], options)).toEqual(
      [],
    );
  });

  it('respects maxSnippets', () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      path: 'f' + index + '.ts',
      content: 'calculate total amount ' + index,
      startLine: 0,
    }));
    expect(selectNeighborSnippets('calculate total amount', candidates, options)).toHaveLength(3);
  });

  it('respects maxTotalChars', () => {
    const candidates = [
      { path: 'a.ts', content: 'calculate total ' + 'x'.repeat(500), startLine: 0 },
      { path: 'b.ts', content: 'calculate total ' + 'y'.repeat(500), startLine: 0 },
    ];
    const selected = selectNeighborSnippets('calculate total', candidates, {
      ...options,
      maxTotalChars: 600,
    });
    expect(selected).toHaveLength(1);
  });

  it('truncates a snippet longer than maxSnippetChars', () => {
    const long = 'calculate total ' + 'z'.repeat(2000);
    const selected = selectNeighborSnippets('calculate total', [{ path: 'a.ts', content: long, startLine: 0 }], {
      ...options,
      maxSnippetChars: 100,
    });
    expect(selected[0]?.content.length).toBeLessThanOrEqual(100);
  });

  it('skips blank snippets', () => {
    const selected = selectNeighborSnippets(
      'calculate total',
      [{ path: 'a.ts', content: '   ', startLine: 0 }],
      options,
    );
    expect(selected).toEqual([]);
  });

  it('breaks score ties by shorter content', () => {
    const selected = selectNeighborSnippets(
      'calculate total',
      [
        { path: 'long.ts', content: 'calculate total' + ' padding'.repeat(10), startLine: 0 },
        { path: 'short.ts', content: 'calculate total', startLine: 0 },
      ],
      { ...options, threshold: 0 },
    );
    expect(selected[0]?.path).toBe('short.ts');
  });
});
