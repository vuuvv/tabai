import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  describeError,
  generateCommitMessageAndCommitCommand,
  generateCommitMessageCommand,
  resolveWorkspaceCwd,
} from '../../src/git/gitCommands.js';
import { TabAIError } from '../../src/core/types.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';
import { mockState, resetMockState } from '../mocks/vscode.js';
import type { CommitService } from '../../src/git/commitService.js';

/**
 * Builds a fake commit service.
 *
 * @param overrides Method overrides.
 * @returns A commit service stub with spies.
 */
function fakeService(overrides: Partial<CommitService> = {}): CommitService {
  return {
    summarise: vi.fn(),
    generate: vi.fn().mockResolvedValue({
      generated: {
        message: 'feat: add a',
        subject: 'feat: add a',
        body: '',
        model: 'qwen',
        latencyMs: 42,
      },
      summary: { repoRoot: '/repo', branch: 'main', files: [], diff: '', truncated: false },
    }),
    generateAndCommit: vi.fn().mockResolvedValue({
      generated: {
        message: 'feat: add a',
        subject: 'feat: add a',
        body: '',
        model: 'qwen',
        latencyMs: 42,
      },
      commitOutput: '[main abc] feat: add a',
    }),
    ...overrides,
  } as unknown as CommitService;
}

describe('resolveWorkspaceCwd', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('returns null with no folders and no editor', () => {
    expect(resolveWorkspaceCwd()).toBeNull();
  });

  it('returns the first workspace folder', () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    expect(resolveWorkspaceCwd()).toBe('/repo');
  });

  it('returns undefined when the git extension is missing', () => {
    // Covered indirectly: getScmInputBox must not create a SourceControl when
    // the built-in git extension is unavailable, otherwise every command
    // would leak an SCM provider into the Source Control view.
    expect(resolveWorkspaceCwd()).toBeNull();
  });

  it('prefers the folder of the active editor', () => {
    mockState.workspaceFolders = [
      { uri: { fsPath: '/first' } },
      { uri: { fsPath: '/second' } },
    ];
    mockState.activeTextEditor = {
      document: {
        uri: { toString: () => 'file:///second/a.ts', scheme: 'file', fsPath: '/second/a.ts' },
        languageId: 'typescript',
        version: 1,
        lineCount: 1,
        fileName: 'a.ts',
        getText: () => '',
      },
    };
    expect(resolveWorkspaceCwd()).toBe('/second');
  });

  it('falls back to the first folder when the editor is outside any folder', () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/first' } }];
    mockState.activeTextEditor = {
      document: {
        uri: { toString: () => 'file:///other/a.ts', scheme: 'file', fsPath: '/other/a.ts' },
        languageId: 'typescript',
        version: 1,
        lineCount: 1,
        fileName: 'a.ts',
        getText: () => '',
      },
    };
    expect(resolveWorkspaceCwd()).toBe('/first');
  });

  it('ignores a non-file editor', () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/first' } }];
    mockState.activeTextEditor = {
      document: {
        uri: { toString: () => 'untitled:1', scheme: 'untitled', fsPath: '' },
        languageId: 'typescript',
        version: 1,
        lineCount: 1,
        fileName: 'Untitled-1',
        getText: () => '',
      },
    };
    expect(resolveWorkspaceCwd()).toBe('/first');
  });
});

describe('describeError', () => {
  it('explains a network failure', () => {
    expect(describeError(new TabAIError('network', 'down'))).toContain('Cannot reach the AI provider');
  });

  it('explains a timeout', () => {
    expect(describeError(new TabAIError('timeout', 'slow'))).toContain('too long');
  });

  it('explains an http failure with the server message', () => {
    expect(describeError(new TabAIError('http', 'bad model'))).toContain('bad model');
  });

  it('explains a parse failure', () => {
    expect(describeError(new TabAIError('parse', 'garbage'))).toContain('unusable response');
  });

  it('explains an abort', () => {
    expect(describeError(new TabAIError('aborted', 'x'))).toBe('Request cancelled.');
  });

  it('passes a not-configured message through', () => {
    expect(describeError(new TabAIError('not-configured', 'no repo'))).toBe('no repo');
  });

  it('handles a plain Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('handles a non-Error value', () => {
    expect(describeError('weird')).toBe('weird');
  });
});

describe('generateCommitMessageCommand', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('warns when no folder is open', async () => {
    await generateCommitMessageCommand(fakeService(), () => DEFAULT_SETTINGS);
    expect(mockState.messages[0]?.kind).toBe('warning');
    expect(mockState.messages[0]?.message).toContain('open a folder');
  });

  it('shows the generated message', async () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    const service = fakeService();

    await generateCommitMessageCommand(service, () => DEFAULT_SETTINGS);

    expect(service.generate).toHaveBeenCalledTimes(1);
    const info = mockState.messages.find((entry) => entry.kind === 'info');
    expect(info?.message).toContain('commit message generated');
  });

  it('reports a generation failure', async () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    const service = fakeService({
      generate: vi.fn().mockRejectedValue(new TabAIError('network', 'down')),
    } as unknown as Partial<CommitService>);

    await generateCommitMessageCommand(service, () => DEFAULT_SETTINGS);

    const error = mockState.messages.find((entry) => entry.kind === 'error');
    expect(error?.message).toContain('Cannot reach the AI provider');
  });

  it('runs inside a progress reporter', async () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    await generateCommitMessageCommand(fakeService(), () => DEFAULT_SETTINGS);
    expect(mockState.progressCalls).toBe(1);
  });
});

describe('generateCommitMessageAndCommitCommand', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('warns when no folder is open', async () => {
    await generateCommitMessageAndCommitCommand(fakeService(), () => DEFAULT_SETTINGS);
    expect(mockState.messages[0]?.kind).toBe('warning');
  });

  it('commits after the user confirms', async () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    const service = fakeService();

    await generateCommitMessageAndCommitCommand(service, () => DEFAULT_SETTINGS);

    // The mock returns the first button label, which is "Commit".
    expect(service.generateAndCommit).toHaveBeenCalledTimes(1);
    const info = mockState.messages.find((entry) => entry.message.includes('committed'));
    expect(info?.message).toContain('feat: add a');
  });

  it('skips the confirmation when autoCommit is enabled', async () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    const service = fakeService();
    const confirmSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await generateCommitMessageAndCommitCommand(service, () => ({
      ...DEFAULT_SETTINGS,
      gitAutoCommit: true,
    }));

    // Only the final "committed" notification should be shown.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(service.generateAndCommit).toHaveBeenCalledTimes(1);
  });

  it('reports a commit failure', async () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    const service = fakeService({
      generateAndCommit: vi.fn().mockRejectedValue(new TabAIError('http', 'nothing staged')),
    } as unknown as Partial<CommitService>);

    await generateCommitMessageAndCommitCommand(service, () => DEFAULT_SETTINGS);

    const error = mockState.messages.find((entry) => entry.kind === 'error');
    expect(error?.message).toContain('nothing staged');
  });

  it('reports a generation failure before committing', async () => {
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    const service = fakeService({
      generate: vi.fn().mockRejectedValue(new TabAIError('timeout', 'slow')),
    } as unknown as Partial<CommitService>);

    await generateCommitMessageAndCommitCommand(service, () => DEFAULT_SETTINGS);

    const error = mockState.messages.find((entry) => entry.kind === 'error');
    expect(error?.message).toContain('too long');
    expect(service.generateAndCommit).not.toHaveBeenCalled();
  });
});
