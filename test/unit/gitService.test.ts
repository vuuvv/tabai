import { describe, expect, it } from 'vitest';
import { GitService, defaultGitRunner } from '../../src/git/gitService.js';
import type { GitCommandResult, GitRunner } from '../../src/git/gitService.js';
import { TabAIError } from '../../src/core/types.js';

/**
 * Builds a runner that answers commands from a lookup table.
 *
 * @param responses Map from the joined argument string to a canned result.
 * @returns A runner plus the list of invoked commands.
 */
function runnerFrom(responses: Record<string, Partial<GitCommandResult>>): {
  runner: GitRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: GitRunner = async (args, cwd, timeoutMs) => {
    const key = args.join(' ');
    calls.push(key);
    void cwd;
    void timeoutMs;
    const canned = responses[key];
    if (canned === undefined) {
      return { stdout: '', stderr: 'unexpected command: ' + key, code: 128 };
    }
    return {
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      code: canned.code ?? 0,
    };
  };
  return { runner, calls };
}

describe('GitService.getRepoRoot', () => {
  it('returns the trimmed root path', async () => {
    const { runner } = runnerFrom({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
    });
    const service = new GitService({ runner });
    expect(await service.getRepoRoot('/repo/src')).toBe('/repo');
  });

  it('returns null outside a repository', async () => {
    const { runner } = runnerFrom({
      'rev-parse --show-toplevel': { code: 128, stderr: 'not a repo' },
    });
    const service = new GitService({ runner });
    expect(await service.getRepoRoot('/tmp')).toBeNull();
  });

  it('returns null for an empty root', async () => {
    const { runner } = runnerFrom({ 'rev-parse --show-toplevel': { stdout: '  \n' } });
    const service = new GitService({ runner });
    expect(await service.getRepoRoot('/tmp')).toBeNull();
  });
});

describe('GitService.getBranch', () => {
  it('returns the branch name', async () => {
    const { runner } = runnerFrom({ 'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' } });
    const service = new GitService({ runner });
    expect(await service.getBranch('/repo')).toBe('main');
  });

  it('falls back to HEAD when the command fails', async () => {
    const { runner } = runnerFrom({ 'rev-parse --abbrev-ref HEAD': { code: 1 } });
    const service = new GitService({ runner });
    expect(await service.getBranch('/repo')).toBe('HEAD');
  });

  it('falls back to HEAD for empty output', async () => {
    const { runner } = runnerFrom({ 'rev-parse --abbrev-ref HEAD': { stdout: '' } });
    const service = new GitService({ runner });
    expect(await service.getBranch('/repo')).toBe('HEAD');
  });
});

describe('GitService.hasCommits', () => {
  it('is true when HEAD resolves', async () => {
    const { runner } = runnerFrom({ 'rev-parse --verify HEAD': { stdout: 'abc' } });
    const service = new GitService({ runner });
    expect(await service.hasCommits('/repo')).toBe(true);
  });

  it('is false for an empty repository', async () => {
    const { runner } = runnerFrom({ 'rev-parse --verify HEAD': { code: 128 } });
    const service = new GitService({ runner });
    expect(await service.hasCommits('/repo')).toBe(false);
  });
});

describe('GitService.collectSummary', () => {
  const baseResponses = {
    'rev-parse --show-toplevel': { stdout: '/repo\n' },
    'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
    'status --porcelain=v1 -z --untracked-files=all': { stdout: ' M a.ts\0' },
    'diff --numstat HEAD --': { stdout: '2\t1\ta.ts\n' },
    'rev-parse --verify HEAD': { stdout: 'abc' },
    'diff HEAD --no-color --unified=3 --': { stdout: '+const a = 1;' },
  };

  it('collects a complete summary', async () => {
    const { runner } = runnerFrom(baseResponses);
    const service = new GitService({ runner });
    const summary = await service.collectSummary('/repo/src', 1000);

    expect(summary).not.toBeNull();
    expect(summary?.branch).toBe('main');
    expect(summary?.files).toHaveLength(1);
    expect(summary?.files[0]?.insertions).toBe(2);
    expect(summary?.diff).toContain('+const a = 1;');
  });

  it('returns null when the repository is clean', async () => {
    const { runner } = runnerFrom({
      ...baseResponses,
      'status --porcelain=v1 -z --untracked-files=all': { stdout: '' },
    });
    const service = new GitService({ runner });
    expect(await service.collectSummary('/repo', 1000)).toBeNull();
  });

  it('throws when the directory is not a repository', async () => {
    const { runner } = runnerFrom({
      'rev-parse --show-toplevel': { code: 128 },
    });
    const service = new GitService({ runner });
    await expect(service.collectSummary('/tmp', 1000)).rejects.toMatchObject({
      kind: 'not-configured',
    });
  });

  it('uses the cached diff in a repository without commits', async () => {
    const { runner, calls } = runnerFrom({
      ...baseResponses,
      'rev-parse --verify HEAD': { code: 128 },
      'diff --cached --no-color --unified=3 --': { stdout: '+new file' },
    });
    const service = new GitService({ runner });
    const summary = await service.collectSummary('/repo', 1000);

    expect(calls).toContain('diff --cached --no-color --unified=3 --');
    expect(summary?.diff).toContain('+new file');
  });

  it('appends a listing for untracked files', async () => {
    const { runner } = runnerFrom({
      ...baseResponses,
      'status --porcelain=v1 -z --untracked-files=all': { stdout: '?? new.ts\0' },
      'diff --numstat HEAD --': { stdout: '' },
    });
    const service = new GitService({ runner });
    const summary = await service.collectSummary('/repo', 1000);

    expect(summary?.diff).toContain('new file: new.ts');
  });

  it('tolerates a failing numstat command', async () => {
    const { runner } = runnerFrom({
      ...baseResponses,
      'diff --numstat HEAD --': { code: 1 },
    });
    const service = new GitService({ runner });
    const summary = await service.collectSummary('/repo', 1000);
    expect(summary?.files[0]?.insertions).toBe(0);
  });

  it('tolerates a failing diff command', async () => {
    const { runner } = runnerFrom({
      ...baseResponses,
      'diff HEAD --no-color --unified=3 --': { code: 1 },
    });
    const service = new GitService({ runner });
    const summary = await service.collectSummary('/repo', 1000);
    expect(summary?.diff).toBe('');
  });

  it('truncates a large diff', async () => {
    const { runner } = runnerFrom({
      ...baseResponses,
      'diff HEAD --no-color --unified=3 --': { stdout: 'x'.repeat(500) },
    });
    const service = new GitService({ runner });
    const summary = await service.collectSummary('/repo', 50);
    expect(summary?.truncated).toBe(true);
  });
});

describe('GitService.stageAll', () => {
  it('runs git add --all', async () => {
    const { runner, calls } = runnerFrom({ 'add --all': { code: 0 } });
    const service = new GitService({ runner });
    await service.stageAll('/repo');
    expect(calls).toContain('add --all');
  });

  it('throws when staging fails', async () => {
    const { runner } = runnerFrom({ 'add --all': { code: 1, stderr: 'denied' } });
    const service = new GitService({ runner });
    await expect(service.stageAll('/repo')).rejects.toBeInstanceOf(TabAIError);
  });
});

describe('GitService.commit', () => {
  it('passes each paragraph as its own -m flag', async () => {
    const { runner, calls } = runnerFrom({
      'commit -m feat: add -m body text': { stdout: '[main abc] feat: add' },
    });
    const service = new GitService({ runner });
    const output = await service.commit('/repo', 'feat: add\n\nbody text');

    expect(calls[0]).toBe('commit -m feat: add -m body text');
    expect(output).toContain('[main abc]');
  });

  it('handles a subject-only message', async () => {
    const { runner, calls } = runnerFrom({ 'commit -m fix: x': { stdout: 'ok' } });
    const service = new GitService({ runner });
    await service.commit('/repo', 'fix: x');
    expect(calls[0]).toBe('commit -m fix: x');
  });

  it('throws when the commit fails', async () => {
    const { runner } = runnerFrom({ 'commit -m fix: x': { code: 1, stderr: 'nothing staged' } });
    const service = new GitService({ runner });
    await expect(service.commit('/repo', 'fix: x')).rejects.toMatchObject({ kind: 'http' });
  });

  it('ignores empty paragraphs', async () => {
    const { runner, calls } = runnerFrom({ 'commit -m a -m b': { stdout: 'ok' } });
    const service = new GitService({ runner });
    await service.commit('/repo', 'a\n\n\n\nb');
    expect(calls[0]).toBe('commit -m a -m b');
  });
});

describe('GitService constructor', () => {
  it('accepts an injected timeout', async () => {
    const seen: number[] = [];
    const runner: GitRunner = async (_args, _cwd, timeoutMs) => {
      seen.push(timeoutMs);
      return { stdout: '/repo', stderr: '', code: 0 };
    };
    const service = new GitService({ runner, timeoutMs: 1234 });
    await service.getRepoRoot('/repo');
    expect(seen[0]).toBe(1234);
  });
});

describe('defaultGitRunner', () => {
  it('runs a real command and captures stdout', async () => {
    const result = await defaultGitRunner(['--version'], process.cwd(), 10000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('git version');
  });

  it('resolves a non-zero exit code instead of rejecting', async () => {
    const result = await defaultGitRunner(['rev-parse', '--verify', 'no-such-ref-xyz'], process.cwd(), 10000);
    expect(result.code).not.toBe(0);
  });
});
