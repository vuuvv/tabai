import { describe, expect, it } from 'vitest';
import {
  applyNumstat,
  buildDiffSummary,
  countDiffLines,
  normaliseStatusCode,
  parsePorcelainStatus,
  truncateDiff,
} from '../../src/git/diffSummary.js';

describe('parsePorcelainStatus', () => {
  it('parses modified files', () => {
    const changes = parsePorcelainStatus(' M src/a.ts\0');
    expect(changes).toEqual([{ path: 'src/a.ts', status: 'M', insertions: 0, deletions: 0 }]);
  });

  it('parses staged additions', () => {
    const changes = parsePorcelainStatus('A  src/new.ts\0');
    expect(changes[0]?.status).toBe('A');
  });

  it('parses untracked files as additions', () => {
    const changes = parsePorcelainStatus('?? src/new.ts\0');
    expect(changes[0]).toEqual({
      path: 'src/new.ts',
      status: 'A',
      insertions: 0,
      deletions: 0,
    });
  });

  it('parses deletions', () => {
    const changes = parsePorcelainStatus(' D src/gone.ts\0');
    expect(changes[0]?.status).toBe('D');
  });

  it('skips the original path of a rename', () => {
    const stdout = 'R  src/new.ts\0src/old.ts\0';
    const changes = parsePorcelainStatus(stdout);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe('src/new.ts');
    expect(changes[0]?.status).toBe('R');
  });

  it('skips the original path of a copy', () => {
    const stdout = 'C  src/copy.ts\0src/orig.ts\0';
    const changes = parsePorcelainStatus(stdout);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe('src/copy.ts');
  });

  it('parses multiple records', () => {
    const stdout = ' M a.ts\0A  b.ts\0?? c.ts\0';
    expect(parsePorcelainStatus(stdout)).toHaveLength(3);
  });

  it('preserves paths containing spaces', () => {
    const changes = parsePorcelainStatus(' M src/my file.ts\0');
    expect(changes[0]?.path).toBe('src/my file.ts');
  });

  it('returns an empty array for empty output', () => {
    expect(parsePorcelainStatus('')).toEqual([]);
  });

  it('ignores malformed records', () => {
    expect(parsePorcelainStatus('ab\0')).toEqual([]);
  });

  it('handles a record with no trailing NUL', () => {
    expect(parsePorcelainStatus(' M a.ts')).toHaveLength(1);
  });
});

describe('normaliseStatusCode', () => {
  it('maps untracked to A', () => {
    expect(normaliseStatusCode('?', '?')).toBe('A');
  });

  it('maps conflicts to U', () => {
    expect(normaliseStatusCode('U', 'U')).toBe('U');
    expect(normaliseStatusCode(' ', 'U')).toBe('U');
  });

  it('maps deletions to D', () => {
    expect(normaliseStatusCode(' ', 'D')).toBe('D');
  });

  it('maps renames to R', () => {
    expect(normaliseStatusCode('R', ' ')).toBe('R');
  });

  it('maps staged additions to A', () => {
    expect(normaliseStatusCode('A', ' ')).toBe('A');
  });

  it('maps modifications to M', () => {
    expect(normaliseStatusCode('M', ' ')).toBe('M');
    expect(normaliseStatusCode(' ', 'M')).toBe('M');
  });

  it('falls back to M for an unknown combination', () => {
    expect(normaliseStatusCode(' ', ' ')).toBe('M');
  });
});

describe('applyNumstat', () => {
  const files = [
    { path: 'a.ts', status: 'M', insertions: 0, deletions: 0 },
    { path: 'b.ts', status: 'M', insertions: 0, deletions: 0 },
  ];

  it('merges insertion and deletion counts', () => {
    const merged = applyNumstat('3\t1\ta.ts\n5\t0\tb.ts\n', files);
    expect(merged[0]?.insertions).toBe(3);
    expect(merged[0]?.deletions).toBe(1);
    expect(merged[1]?.insertions).toBe(5);
  });

  it('treats binary markers as zero', () => {
    const merged = applyNumstat('-\t-\ta.ts\n', files);
    expect(merged[0]?.insertions).toBe(0);
    expect(merged[0]?.deletions).toBe(0);
  });

  it('leaves unmatched files at zero', () => {
    const merged = applyNumstat('1\t1\tz.ts\n', files);
    expect(merged[0]?.insertions).toBe(0);
  });

  it('handles paths containing tabs', () => {
    const merged = applyNumstat('2\t3\tsrc/a\tb.ts\n', [
      { path: 'src/a\tb.ts', status: 'M', insertions: 0, deletions: 0 },
    ]);
    expect(merged[0]?.insertions).toBe(2);
  });

  it('ignores malformed lines', () => {
    expect(applyNumstat('garbage\n', files)[0]?.insertions).toBe(0);
  });

  it('returns a new array without mutating the input', () => {
    const merged = applyNumstat('1\t1\ta.ts\n', files);
    expect(merged).not.toBe(files);
    expect(files[0]?.insertions).toBe(0);
  });
});

describe('truncateDiff', () => {
  it('returns short diffs unchanged', () => {
    expect(truncateDiff('abc', 100)).toEqual({ diff: 'abc', truncated: false });
  });

  it('truncates at a line boundary', () => {
    const result = truncateDiff('aaa\nbbb\nccc', 8);
    expect(result.truncated).toBe(true);
    expect(result.diff).toBe('aaa\nbbb');
  });

  it('truncates mid-line when there is no newline', () => {
    const result = truncateDiff('a'.repeat(50), 10);
    expect(result.diff).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it('returns an empty diff for a zero budget', () => {
    expect(truncateDiff('abc', 0)).toEqual({ diff: '', truncated: true });
  });

  it('reports no truncation for an empty diff', () => {
    expect(truncateDiff('', 0)).toEqual({ diff: '', truncated: false });
  });

  it('keeps a diff exactly at the limit', () => {
    expect(truncateDiff('abcde', 5)).toEqual({ diff: 'abcde', truncated: false });
  });
});

describe('countDiffLines', () => {
  it('counts added and removed lines', () => {
    const diff = '+++ b/a\n--- a/a\n+one\n+two\n-three\n context';
    expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 });
  });

  it('ignores file headers', () => {
    expect(countDiffLines('+++ b/a\n--- a/a')).toEqual({ added: 0, removed: 0 });
  });

  it('handles an empty diff', () => {
    expect(countDiffLines('')).toEqual({ added: 0, removed: 0 });
  });
});

describe('buildDiffSummary', () => {
  it('assembles the summary from raw outputs', () => {
    const summary = buildDiffSummary({
      repoRoot: '/repo',
      branch: 'main',
      porcelainStdout: ' M a.ts\0',
      numstatStdout: '2\t1\ta.ts\n',
      diffStdout: '+const a = 1;',
      maxDiffChars: 1000,
    });

    expect(summary.repoRoot).toBe('/repo');
    expect(summary.branch).toBe('main');
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]?.insertions).toBe(2);
    expect(summary.diff).toBe('+const a = 1;');
    expect(summary.truncated).toBe(false);
  });

  it('marks a truncated diff', () => {
    const summary = buildDiffSummary({
      repoRoot: '/repo',
      branch: 'main',
      porcelainStdout: ' M a.ts\0',
      numstatStdout: '',
      diffStdout: 'x'.repeat(100),
      maxDiffChars: 10,
    });
    expect(summary.truncated).toBe(true);
  });

  it('handles a repository with no changes', () => {
    const summary = buildDiffSummary({
      repoRoot: '/repo',
      branch: 'main',
      porcelainStdout: '',
      numstatStdout: '',
      diffStdout: '',
      maxDiffChars: 1000,
    });
    expect(summary.files).toEqual([]);
    expect(summary.diff).toBe('');
  });
});
