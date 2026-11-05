import { beforeEach, describe, expect, it } from 'vitest';
import { getScmInputBox } from '../../src/git/gitCommands.js';
import { mockState, resetMockState } from '../mocks/vscode.js';

describe('getScmInputBox', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('returns the first repository input box by default', () => {
    mockState.repositories = [
      { rootUri: { fsPath: '/a' }, inputBox: { value: '' } },
      { rootUri: { fsPath: '/b' }, inputBox: { value: '' } },
    ];
    expect(getScmInputBox()).toBe(mockState.repositories[0]?.inputBox);
  });

  it('selects the repository that contains the cwd', () => {
    const first = { rootUri: { fsPath: '/a' }, inputBox: { value: '' } };
    const second = { rootUri: { fsPath: '/b' }, inputBox: { value: '' } };
    mockState.repositories = [first, second];

    expect(getScmInputBox('/b/src')).toBe(second.inputBox);
    expect(getScmInputBox('/a')).toBe(first.inputBox);
  });

  it('matches an exact repository root', () => {
    const repo = { rootUri: { fsPath: '/repo' }, inputBox: { value: '' } };
    mockState.repositories = [repo];
    expect(getScmInputBox('/repo')).toBe(repo.inputBox);
  });

  it('does not match a sibling path that merely shares a prefix', () => {
    const repoA = { rootUri: { fsPath: '/repo' }, inputBox: { value: '' } };
    const repoB = { rootUri: { fsPath: '/repo-other' }, inputBox: { value: '' } };
    mockState.repositories = [repoA, repoB];

    // "/repo-other/x" must resolve to repoB, not repoA, because repoA's path
    // is only a textual prefix.
    expect(getScmInputBox('/repo-other/x')).toBe(repoB.inputBox);
  });

  it('falls back to the first repository when nothing matches', () => {
    mockState.repositories = [{ rootUri: { fsPath: '/a' }, inputBox: { value: '' } }];
    expect(getScmInputBox('/elsewhere')).toBe(mockState.repositories[0]?.inputBox);
  });

  it('returns undefined when there are no repositories', () => {
    mockState.repositories = [];
    expect(getScmInputBox()).toBeUndefined();
  });
});
