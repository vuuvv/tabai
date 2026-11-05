import { describe, expect, it } from 'vitest';
import { computeInsertionRange } from '../../src/completion/engine.js';

describe('computeInsertionRange', () => {
  it('inserts at the cursor when nothing overlaps', () => {
    const range = computeInsertionRange({ line: 0, character: 0 }, '', 'return a;');
    expect(range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
  });

  it('does not swallow text after the cursor', () => {
    // The regression this guards: completing "calculate" to "calculate_total"
    // must not delete "(a, b)".
    const line = 'result = calculate(a, b)';
    const range = computeInsertionRange({ line: 0, character: 18 }, line, 'calculate_total');
    expect(range.start.character).toBe(18);
    expect(range.end.character).toBe(18);
  });

  it('replaces a tail that the completion already starts with', () => {
    // Cursor sits before "cal"; the completion spells the whole word, so the
    // range must cover "cal" or accepting would produce "calculatecal".
    const line = 'x = cal';
    const range = computeInsertionRange({ line: 0, character: 4 }, line, 'calculate');
    expect(range.start.character).toBe(4);
    expect(range.end.character).toBe(7);
  });

  it('consumes a matching tail exactly', () => {
    const line = 'foo(bar)';
    // Cursor after "foo(", completing "bar)" which matches the rest verbatim.
    const range = computeInsertionRange({ line: 0, character: 4 }, line, 'bar)');
    expect(range.start.character).toBe(4);
    expect(range.end.character).toBe(8);
  });

  it('stops at the first mismatch', () => {
    // tail is "XY", completion starts with "a": nothing is superseded.
    const line = 'abcXY';
    const range = computeInsertionRange({ line: 0, character: 3 }, line, 'abZ');
    expect(range.end.character).toBe(3);
  });

  it('stops partway when the prefix matches but the next character differs', () => {
    const line = 'abXY';
    const range = computeInsertionRange({ line: 0, character: 2 }, line, 'XYextra');
    expect(range.end.character).toBe(4);
  });

  it('never exceeds the end of the line', () => {
    // tail is "ort", completion starts with "h": no overlap, range stays put.
    const line = 'short';
    const range = computeInsertionRange({ line: 0, character: 2 }, line, 'hort and much longer');
    expect(range.end.character).toBe(2);
  });

  it('clamps a negative cursor to zero', () => {
    const range = computeInsertionRange({ line: 0, character: -5 }, 'abc', 'a');
    expect(range.start.character).toBe(0);
  });

  it('handles an empty line', () => {
    const range = computeInsertionRange({ line: 3, character: 0 }, '', 'x');
    expect(range.start).toEqual({ line: 3, character: 0 });
    expect(range.end).toEqual({ line: 3, character: 0 });
  });

  it('keeps the range on a single line', () => {
    const range = computeInsertionRange({ line: 7, character: 2 }, 'abcdef', 'cdef');
    expect(range.start.line).toBe(7);
    expect(range.end.line).toBe(7);
  });

  it('defaults the completion text to empty', () => {
    const range = computeInsertionRange({ line: 0, character: 1 }, 'abc');
    expect(range.end.character).toBe(1);
  });
});
