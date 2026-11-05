import { describe, expect, it } from 'vitest';
import { defaultGitRunner } from '../../src/git/gitService.js';
import { TabAIError } from '../../src/core/types.js';

describe('defaultGitRunner spawn failure handling', () => {
  it('resolves with a non-zero code for a failing git command', async () => {
    // A well-formed but unknown subcommand makes git exit non-zero without
    // failing to spawn; the runner must resolve, not reject, in that case.
    const result = await defaultGitRunner(
      ['this-subcommand-does-not-exist'],
      process.cwd(),
      5000,
    );
    expect(result.code).not.toBe(0);
    expect(typeof result.stderr).toBe('string');
  });

  it('rejects with not-configured when git cannot be spawned', async () => {
    const originalPath = process.env['PATH'];
    // Blanking PATH makes the spawn fail with ENOENT, which is the branch
    // that maps to a "git is not installed" TabAIError.
    process.env['PATH'] = '';
    try {
      await expect(
        defaultGitRunner(['--version'], process.cwd(), 5000),
      ).rejects.toBeInstanceOf(TabAIError);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});
