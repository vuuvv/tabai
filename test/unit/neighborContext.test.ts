import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NEIGHBOR_OPTIONS,
  buildQueryWindow,
  collectNeighborContext,
  formatNeighborContext,
} from '../../src/completion/neighborContext.js';
import type { NeighborContextOptions } from '../../src/completion/neighborContext.js';

/**
 * Builds options with overrides.
 *
 * @param overrides Fields to override.
 * @returns Complete options.
 */
function optionsWith(
  overrides: Partial<NeighborContextOptions> = {},
): NeighborContextOptions {
  return {
    ...DEFAULT_NEIGHBOR_OPTIONS,
    currentPath: 'src/current.ts',
    query: 'calculate total amount from items',
    ...overrides,
  };
}

describe('collectNeighborContext', () => {
  it('finds a similar snippet in another file', () => {
    const snippets = collectNeighborContext(
      [
        {
          path: 'src/helpers.ts',
          text: 'export function calculateTotal(items) {\n  return items.reduce(sum)\n}\n',
        },
      ],
      optionsWith(),
    );
    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.path).toBe('src/helpers.ts');
    expect(snippets[0]?.score).toBeGreaterThan(0);
  });

  it('never returns the current file', () => {
    const snippets = collectNeighborContext(
      [{ path: 'src/current.ts', text: 'calculate total amount from items' }],
      optionsWith(),
    );
    expect(snippets).toEqual([]);
  });

  it('skips files that do not match', () => {
    const snippets = collectNeighborContext(
      [{ path: 'src/view.ts', text: 'render the viewport dimensions' }],
      optionsWith(),
    );
    expect(snippets).toEqual([]);
  });

  it('returns an empty array for an empty query', () => {
    expect(collectNeighborContext([{ path: 'a.ts', text: 'x' }], optionsWith({ query: '' }))).toEqual(
      [],
    );
  });

  it('skips empty files', () => {
    expect(collectNeighborContext([{ path: 'a.ts', text: '' }], optionsWith())).toEqual([]);
  });

  it('respects maxFiles', () => {
    const files = Array.from({ length: 50 }, (_, index) => ({
      path: 'f' + index + '.ts',
      text: 'calculate total amount from items',
    }));
    const snippets = collectNeighborContext(files, optionsWith({ maxFiles: 3, maxSnippets: 10 }));
    const uniquePaths = new Set(snippets.map((snippet) => snippet.path));
    expect(uniquePaths.size).toBeLessThanOrEqual(3);
  });

  it('truncates a file larger than maxFileChars', () => {
    const huge = 'calculate total amount from items\n' + 'x'.repeat(5000);
    const snippets = collectNeighborContext(
      [{ path: 'big.ts', text: huge }],
      optionsWith({ maxFileChars: 100, windowLines: 100 }),
    );
    expect(snippets[0]?.content.length).toBeLessThanOrEqual(100);
  });

  it('orders results by descending score', () => {
    const snippets = collectNeighborContext(
      [
        { path: 'weak.ts', text: 'calculate something unrelated entirely' },
        { path: 'strong.ts', text: 'calculate total amount from items list' },
      ],
      optionsWith({ maxSnippets: 5, threshold: 0 }),
    );
    expect(snippets.length).toBeGreaterThan(1);
    expect(snippets[0]?.score).toBeGreaterThanOrEqual(snippets[1]?.score ?? 0);
  });

  it('honours a high threshold', () => {
    // A partially matching file scores well below 0.99, so it is filtered out
    // even though it shares several tokens with the query.
    const snippets = collectNeighborContext(
      [{ path: 'a.ts', text: 'calculate total from a completely different list of things' }],
      optionsWith({ threshold: 0.99 }),
    );
    expect(snippets).toEqual([]);
  });

  it('keeps an exact match at threshold 1', () => {
    const snippets = collectNeighborContext(
      [{ path: 'a.ts', text: 'calculate total amount from items' }],
      optionsWith({ threshold: 1 }),
    );
    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.score).toBe(1);
  });

  it('does not throw on a degenerate window size', () => {
    expect(() =>
      collectNeighborContext(
        [{ path: 'a.ts', text: 'calculate total' }],
        optionsWith({ windowLines: 0 }),
      ),
    ).not.toThrow();
  });
});

describe('buildQueryWindow', () => {
  it('extracts lines around the cursor', () => {
    const text = Array.from({ length: 50 }, (_, index) => 'line' + index).join('\n');
    const query = buildQueryWindow(text, 25, 2);
    expect(query).toContain('line24');
    expect(query).toContain('line26');
    expect(query).not.toContain('line0');
  });

  it('defaults to a twenty-line radius', () => {
    const text = Array.from({ length: 100 }, (_, index) => 'l' + index).join('\n');
    const query = buildQueryWindow(text, 50);
    expect(query.split('\n')).toHaveLength(41);
  });

  it('clamps at the file start', () => {
    const query = buildQueryWindow('a\nb\nc', 0, 5);
    expect(query).toBe('a\nb\nc');
  });
});

describe('formatNeighborContext', () => {
  it('labels each snippet with its path and line', () => {
    const formatted = formatNeighborContext([
      { path: 'src/a.ts', content: 'const x = 1;', startLine: 4, score: 0.5 },
    ]);
    expect(formatted).toContain('# src/a.ts (line 5)');
    expect(formatted).toContain('const x = 1;');
  });

  it('separates multiple snippets with a blank line', () => {
    const formatted = formatNeighborContext([
      { path: 'a.ts', content: 'one', startLine: 0, score: 0.5 },
      { path: 'b.ts', content: 'two', startLine: 0, score: 0.4 },
    ]);
    expect(formatted).toContain('\n\n');
  });

  it('returns an empty string for no snippets', () => {
    expect(formatNeighborContext([])).toBe('');
  });
});
