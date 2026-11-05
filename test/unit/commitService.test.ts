import { describe, expect, it, vi } from 'vitest';
import { CommitService } from '../../src/git/commitService.js';
import type { CommitMessageResult, GitDiffSummary, TabAISettings } from '../../src/core/types.js';
import { TabAIError } from '../../src/core/types.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';

/**
 * Builds a settings object with overrides.
 *
 * @param overrides Fields to override.
 * @returns A complete settings object.
 */
function settingsWith(overrides: Partial<TabAISettings> = {}): TabAISettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/**
 * Builds a diff summary.
 *
 * @param overrides Fields to override.
 * @returns A summary.
 */
function summaryWith(overrides: Partial<GitDiffSummary> = {}): GitDiffSummary {
  return {
    repoRoot: '/repo',
    branch: 'main',
    files: [{ path: 'a.ts', status: 'M', insertions: 1, deletions: 0 }],
    diff: '+const a = 1;',
    truncated: false,
    stagedOnly: false,
    ...overrides,
  };
}

/**
 * Builds a commit message result.
 *
 * @returns A generated message.
 */
function messageResult(): CommitMessageResult {
  return {
    message: 'feat: add a',
    subject: 'feat: add a',
    body: '',
    model: 'qwen',
    latencyMs: 12,
  };
}

/**
 * Creates a fake git service.
 *
 * @param summary The summary to return, or null for a clean repository.
 * @returns The fake service plus spies.
 */
function fakeGit(summary: GitDiffSummary | null): {
  service: {
    collectSummary: ReturnType<typeof vi.fn>;
    stageAll: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
  };
} {
  return {
    service: {
      collectSummary: vi.fn().mockResolvedValue(summary),
      stageAll: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue('[main abc] feat: add a'),
    },
  };
}

/**
 * Creates a fake AI client.
 *
 * @param result The message result to return.
 * @returns The fake client plus its spy.
 */
function fakeClient(result: CommitMessageResult = messageResult()): {
  client: { generateCommitMessage: ReturnType<typeof vi.fn> };
} {
  return { client: { generateCommitMessage: vi.fn().mockResolvedValue(result) } };
}

describe('CommitService.summarise', () => {
  it('returns the repository summary', async () => {
    const git = fakeGit(summaryWith());
    const client = fakeClient();
    const service = new CommitService(git.service, client.client);

    const summary = await service.summarise('/repo', settingsWith());
    expect(summary.branch).toBe('main');
  });

  it('passes the configured diff budget to git', async () => {
    const git = fakeGit(summaryWith());
    const client = fakeClient();
    const service = new CommitService(git.service, client.client);

    await service.summarise('/repo', settingsWith({ gitMaxDiffChars: 4321 }));
    expect(git.service.collectSummary).toHaveBeenCalledWith('/repo', 4321);
  });

  it('throws a friendly error for a clean repository', async () => {
    const git = fakeGit(null);
    const client = fakeClient();
    const service = new CommitService(git.service, client.client);

    await expect(service.summarise('/repo', settingsWith())).rejects.toMatchObject({
      kind: 'not-configured',
      message: 'There are no changes to commit',
    });
  });
});

describe('CommitService.generate', () => {
  it('generates a message from the summary', async () => {
    const git = fakeGit(summaryWith());
    const client = fakeClient();
    const service = new CommitService(git.service, client.client);

    const result = await service.generate('/repo', settingsWith());
    expect(result.generated.subject).toBe('feat: add a');
    expect(result.summary.branch).toBe('main');
    expect(client.client.generateCommitMessage).toHaveBeenCalledTimes(1);
  });

  it('forwards the abort signal', async () => {
    const git = fakeGit(summaryWith());
    const client = fakeClient();
    const service = new CommitService(git.service, client.client);
    const controller = new AbortController();

    await service.generate('/repo', settingsWith(), controller.signal);
    expect(client.client.generateCommitMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      controller.signal,
    );
  });

  it('does not stage or commit', async () => {
    const git = fakeGit(summaryWith());
    const client = fakeClient();
    const service = new CommitService(git.service, client.client);

    await service.generate('/repo', settingsWith());
    expect(git.service.stageAll).not.toHaveBeenCalled();
    expect(git.service.commit).not.toHaveBeenCalled();
  });
});

describe('CommitService.generateAndCommit', () => {
  it('stages and commits with the generated message', async () => {
    const git = fakeGit(summaryWith());
    const client = fakeClient();
    const service = new CommitService(git.service, client.client);

    const result = await service.generateAndCommit('/repo', settingsWith());
    expect(git.service.stageAll).toHaveBeenCalledWith('/repo');
    expect(git.service.commit).toHaveBeenCalledWith('/repo', 'feat: add a');
    expect(result.commitOutput).toContain('[main abc]');
  });

  it('does not commit when generation fails', async () => {
    const git = fakeGit(summaryWith());
    const client = {
      generateCommitMessage: vi.fn().mockRejectedValue(new TabAIError('network', 'down')),
    };
    const service = new CommitService(git.service, client);

    await expect(service.generateAndCommit('/repo', settingsWith())).rejects.toMatchObject({
      kind: 'network',
    });
    expect(git.service.commit).not.toHaveBeenCalled();
  });

  it('does not commit when there is nothing to commit', async () => {
    const git = fakeGit(null);
    const client = fakeClient();
    const service = new CommitService(git.service, client.client);

    await expect(service.generateAndCommit('/repo', settingsWith())).rejects.toMatchObject({
      kind: 'not-configured',
    });
    expect(git.service.commit).not.toHaveBeenCalled();
  });

  it('surfaces a commit failure', async () => {
    const git = fakeGit(summaryWith());
    git.service.commit.mockRejectedValue(new TabAIError('http', 'nothing staged'));
    const client = fakeClient();
    const service = new CommitService(git.service, client.client);

    await expect(service.generateAndCommit('/repo', settingsWith())).rejects.toMatchObject({
      kind: 'http',
    });
  });
});
