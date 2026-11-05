import { describe, expect, it } from 'vitest';
import {
  collapseRepeatedLines,
  dropLineRepetition,
  isNoiseOnly,
  normaliseEol,
  postProcessCompletion,
  stripCodeFence,
  stripPrefixOverlap,
  stripSentinels,
} from '../../src/completion/postProcess.js';

describe('stripSentinels', () => {
  it('removes every Qwen sentinel', () => {
    expect(stripSentinels('a<|fim_prefix|>b<|fim_suffix|>c<|fim_middle|>')).toBe('abc');
  });

  it('removes pad and end-of-text sentinels', () => {
    expect(stripSentinels('x<|fim_pad|>y<|endoftext|>z')).toBe('xyz');
  });

  it('removes StarCoder sentinels', () => {
    expect(stripSentinels('a<fim_prefix>b<fim_suffix>c<fim_middle>d<fim_pad>')).toBe('abcd');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripSentinels('const a = 1;')).toBe('const a = 1;');
  });
});

describe('stripCodeFence', () => {
  it('unwraps a fenced block', () => {
    expect(stripCodeFence('\u0060\u0060\u0060ts\nconst a = 1;\n\u0060\u0060\u0060')).toBe(
      'const a = 1;',
    );
  });

  it('unwraps a fence without a language tag', () => {
    expect(stripCodeFence('\u0060\u0060\u0060\nconst a = 1;\n\u0060\u0060\u0060')).toBe(
      'const a = 1;',
    );
  });

  it('leaves an unfenced string alone', () => {
    expect(stripCodeFence('const a = 1;')).toBe('const a = 1;');
  });

  it('leaves a partial fence alone', () => {
    const partial = '\u0060\u0060\u0060ts\nconst a = 1;';
    expect(stripCodeFence(partial)).toBe(partial);
  });
});

describe('stripPrefixOverlap', () => {
  it('removes a re-emitted tail of the prefix', () => {
    expect(stripPrefixOverlap('const a = 1;\nreturn a;', 'const a = 1;')).toBe('\nreturn a;');
  });

  it('removes the longest matching overlap', () => {
    expect(stripPrefixOverlap('abcabc', 'xxabc')).toBe('abc');
  });

  it('returns the completion unchanged when nothing overlaps', () => {
    expect(stripPrefixOverlap('xyz', 'abc')).toBe('xyz');
  });

  it('handles an empty completion', () => {
    expect(stripPrefixOverlap('', 'abc')).toBe('');
  });

  it('handles an empty prefix', () => {
    expect(stripPrefixOverlap('abc', '')).toBe('abc');
  });

  it('respects the overlap limit', () => {
    expect(stripPrefixOverlap('abcdef', 'xxabcdef', 2)).toBe('abcdef');
  });
});

describe('dropLineRepetition', () => {
  it('drops a completion that repeats the current line', () => {
    expect(dropLineRepetition('const a = 1;\nconst b = 2;', 'const a = 1;')).toBe('const b = 2;');
  });

  it('returns an empty string when only the repeated line remains', () => {
    expect(dropLineRepetition('const a = 1;', 'const a = 1;')).toBe('');
  });

  it('keeps a completion that differs from the current line', () => {
    expect(dropLineRepetition('return a;', 'const a = 1;')).toBe('return a;');
  });

  it('ignores an empty current line', () => {
    expect(dropLineRepetition('return a;', '   ')).toBe('return a;');
  });
});

describe('collapseRepeatedLines', () => {
  it('collapses consecutive identical lines', () => {
    expect(collapseRepeatedLines('a\na\na\nb')).toBe('a\nb');
  });

  it('keeps non-consecutive duplicates', () => {
    expect(collapseRepeatedLines('a\nb\na')).toBe('a\nb\na');
  });

  it('keeps consecutive blank lines', () => {
    expect(collapseRepeatedLines('a\n\n\nb')).toBe('a\n\n\nb');
  });

  it('handles a single line', () => {
    expect(collapseRepeatedLines('a')).toBe('a');
  });
});

describe('normaliseEol', () => {
  it('converts CRLF to LF', () => {
    expect(normaliseEol('a\r\nb')).toBe('a\nb');
  });

  it('converts lone CR to LF', () => {
    expect(normaliseEol('a\rb')).toBe('a\nb');
  });

  it('leaves LF untouched', () => {
    expect(normaliseEol('a\nb')).toBe('a\nb');
  });
});

describe('isNoiseOnly', () => {
  it('is true for whitespace only', () => {
    expect(isNoiseOnly('   \n\t')).toBe(true);
  });

  it('is true for punctuation only', () => {
    expect(isNoiseOnly(');')).toBe(true);
    expect(isNoiseOnly('{}[](),;')).toBe(true);
  });

  it('is false when identifiers are present', () => {
    expect(isNoiseOnly('return a;')).toBe(false);
  });

  it('is false for a single character', () => {
    expect(isNoiseOnly('x')).toBe(false);
  });
});

describe('postProcessCompletion', () => {
  const options = { prefix: 'const a = 1;\n', currentLine: 'const a = 1;', multiline: true };

  it('accepts a clean single-line completion', () => {
    const outcome = postProcessCompletion('return a;', options);
    expect(outcome.text).toBe('return a;');
    expect(outcome.reason).toBe('accepted');
  });

  it('rejects an empty response', () => {
    expect(postProcessCompletion('', options)).toEqual({ text: null, reason: 'empty' });
  });

  it('rejects a whitespace-only response', () => {
    expect(postProcessCompletion('   \n  ', options).text).toBeNull();
  });

  it('strips sentinels before evaluating', () => {
    const outcome = postProcessCompletion('return a;<|fim_pad|>', options);
    expect(outcome.text).toBe('return a;');
  });

  it('strips a markdown fence', () => {
    const fenced = '\u0060\u0060\u0060\nreturn a;\n\u0060\u0060\u0060';
    expect(postProcessCompletion(fenced, options).text).toBe('return a;');
  });

  it('removes a re-emitted prefix', () => {
    // The overlap is stripped, then the leading blank line left behind by the
    // repetition check is trimmed, so only the new statement survives.
    const outcome = postProcessCompletion('const a = 1;\nreturn a;', options);
    expect(outcome.text).toBe('return a;');
  });

  it('rejects when nothing remains after overlap removal', () => {
    const outcome = postProcessCompletion('const a = 1;', options);
    expect(outcome.text).toBeNull();
    expect(outcome.reason).toBe('empty-after-overlap');
  });

  it('rejects punctuation-only noise', () => {
    const outcome = postProcessCompletion(');', { ...options, prefix: 'foo(', currentLine: 'foo(' });
    expect(outcome.text).toBeNull();
    expect(outcome.reason).toBe('noise-only');
  });

  it('rejects a result shorter than the minimum length', () => {
    const outcome = postProcessCompletion('ab', { ...options, minLength: 5 });
    expect(outcome.text).toBeNull();
    expect(outcome.reason).toBe('too-short');
  });

  it('truncates to the first line when multiline is disabled', () => {
    const outcome = postProcessCompletion('return a;\nconst b = 2;', {
      ...options,
      multiline: false,
    });
    expect(outcome.text).toBe('return a;');
  });

  it('keeps multiple lines when multiline is enabled', () => {
    const outcome = postProcessCompletion('const b = 2;\nreturn b;', options);
    expect(outcome.text).toBe('const b = 2;\nreturn b;');
  });

  it('collapses runaway repeated lines', () => {
    const outcome = postProcessCompletion('x = 1;\nx = 1;\nx = 1;', options);
    expect(outcome.text).toBe('x = 1;');
  });

  it('normalises CRLF output', () => {
    const outcome = postProcessCompletion('const b = 2;\r\nreturn b;', options);
    expect(outcome.text).toBe('const b = 2;\nreturn b;');
  });
});
