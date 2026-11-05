import { describe, expect, it } from 'vitest';
import { GitService } from '../../src/git/gitService.js';
import type { GitCommandResult, GitRunner } from '../../src/git/gitService.js';

/**
 * Builds a runner backed by a command table.
 *
 * @param responses Map from joined arguments to a canned result.
 * @returns The runner plus the list of invoked commands.
 */
function runnerFrom(responses: Record<string, Partial<GitCommandResult>>): {
  runner: GitRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: GitRunner = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    const canned = responses[key];
    if (canned === undefined) {
      return { stdout: '', stderr: 'unexpected: ' + key, code: 128 };
    }
    return { stdout: canned.stdout ?? '', stderr: canned.stderr ?? '', code: canned.code ?? 0 };
  };
  return { runner, calls };
}

/** Answers shared by every scenario. */
const BASE: Record<string, Partial<GitCommandResult>> = {
  'rev-parse --show-toplevel': { stdout: '/repo\n' },
  'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'rev-parse --verify HEAD': { stdout: 'abc' },
};

describe('GitService.hasStagedChanges', () => {
  it('is true when diff --cached --quiet exits 1', async () => {
    const { runner } = runnerFrom({ 'diff --cached --quiet': { code: 1 } });
    expect(await new GitService({ runner }).hasStagedChanges('/repo')).toBe(true);
  });

  it('is false when diff --cached --quiet exits 0', async () => {
    const { runner } = runnerFrom({ 'diff --cached --quiet': { code: 0 } });
    expect(await new GitService({ runner }).hasStagedChanges('/repo')).toBe(false);
  });

  it('falls back to listing the index for an unusual exit code', async () => {
    const { runner, calls } = runnerFrom({
      'diff --cached --quiet': { code: 128 },
      'diff --cached --name-only': { stdout: 'a.ts\n' },
    });
    expect(await new GitService({ runner }).hasStagedChanges('/repo')).toBe(true);
    expect(calls).toContain('diff --cached --name-only');
  });

  it('is false when the fallback listing is empty', async () => {
    const { runner } = runnerFrom({
      'diff --cached --quiet': { code: 128 },
      'diff --cached --name-only': { stdout: '  \n' },
    });
    expect(await new GitService({ runner }).hasStagedChanges('/repo')).toBe(false);
  });
});

describe('GitService.collectSummary scoping', () => {
  it('describes only the index when something is staged', async () => {
    const { runner, calls } = runnerFrom({
      ...BASE,
      'diff --cached --quiet': { code: 1 },
      'diff --cached --name-status -z --': { stdout: 'M\0src/a.ts\0' },
      'diff --cached --numstat --': { stdout: '3\t1\tsrc/a.ts\n' },
      'diff --cached --no-color --unified=3 --': { stdout: '+staged line' },
    });

    const summary = await new GitService({ runner }).collectSummary('/repo', 1000);

    expect(summary?.stagedOnly).toBe(true);
    expect(summary?.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(summary?.diff).toContain('+staged line');
    // Porcelain must not be consulted: it would leak unstaged paths.
    expect(calls).not.toContain('status --porcelain=v1 -z --untracked-files=all');
  });

  it('excludes unstaged and untracked files from the staged summary', async () => {
    const { runner } = runnerFrom({
      ...BASE,
      'diff --cached --quiet': { code: 1 },
      'diff --cached --name-status -z --': { stdout: 'M\0staged.ts\0' },
      'diff --cached --numstat --': { stdout: '1\t0\tstaged.ts\n' },
      'diff --cached --no-color --unified=3 --': { stdout: '+x' },
    });

    const summary = await new GitService({ runner }).collectSummary('/repo', 1000);
    expect(summary?.files).toHaveLength(1);
    expect(summary?.files[0]?.path).toBe('staged.ts');
  });

  it('describes every change when nothing is staged', async () => {
    const { runner, calls } = runnerFrom({
      ...BASE,
      'diff --cached --quiet': { code: 0 },
      'status --porcelain=v1 -z --untracked-files=all': { stdout: ' M a.ts\0?? b.ts\0' },
      'diff --numstat HEAD --': { stdout: '2\t0\ta.ts\n' },
      'diff HEAD --no-color --unified=3 --': { stdout: '+unstaged' },
    });

    const summary = await new GitService({ runner }).collectSummary('/repo', 1000);

    expect(summary?.stagedOnly).toBe(false);
    expect(summary?.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(calls).not.toContain('diff --cached --name-status -z --');
  });

  it('lists untracked files in the unstaged case', async () => {
    const { runner } = runnerFrom({
      ...BASE,
      'diff --cached --quiet': { code: 0 },
      'status --porcelain=v1 -z --untracked-files=all': { stdout: '?? brand-new.ts\0' },
      'diff --numstat HEAD --': { stdout: '' },
      'diff HEAD --no-color --unified=3 --': { stdout: '' },
    });

    const summary = await new GitService({ runner }).collectSummary('/repo', 1000);
    expect(summary?.diff).toContain('new file: brand-new.ts');
  });

  it('returns null when nothing is staged and the tree is clean', async () => {
    const { runner } = runnerFrom({
      ...BASE,
      'diff --cached --quiet': { code: 0 },
      'status --porcelain=v1 -z --untracked-files=all': { stdout: '' },
    });

    expect(await new GitService({ runner }).collectSummary('/repo', 1000)).toBeNull();
  });

  it('returns null when the staged file list is empty', async () => {
    const { runner } = runnerFrom({
      ...BASE,
      'diff --cached --quiet': { code: 1 },
      'diff --cached --name-status -z --': { stdout: '' },
      'diff --cached --numstat --': { stdout: '' },
      'diff --cached --no-color --unified=3 --': { stdout: '' },
    });

    // --quiet said "dirty" but --name-status is empty: treat as nothing to do.
    expect(await new GitService({ runner }).collectSummary('/repo', 1000)).toBeNull();
  });
});
