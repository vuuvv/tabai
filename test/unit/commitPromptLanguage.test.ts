import { describe, expect, it } from 'vitest';
import { buildCommitPrompt } from '../../src/ai/prompts.js';
import type { GitDiffSummary } from '../../src/core/types.js';

/**
 * Builds a diff summary.
 *
 * @param overrides Fields to override.
 * @returns A summary fixture.
 */
function summaryWith(overrides: Partial<GitDiffSummary> = {}): GitDiffSummary {
  return {
    repoRoot: '/repo',
    branch: 'main',
    files: [{ path: 'src/a.ts', status: 'M', insertions: 3, deletions: 1 }],
    diff: '+const a = 1;',
    truncated: false,
    stagedOnly: true,
    ...overrides,
  };
}

describe('buildCommitPrompt language', () => {
  it('asks for English by default', () => {
    expect(buildCommitPrompt(summaryWith(), true, 'en')).toContain(
      'Write the message in English.',
    );
  });

  it('asks for Simplified Chinese when configured', () => {
    expect(buildCommitPrompt(summaryWith(), true, 'zh-CN')).toContain(
      'Write the message in Simplified Chinese.',
    );
  });

  it('never asks for both languages at once', () => {
    const zh = buildCommitPrompt(summaryWith(), true, 'zh-CN');
    expect(zh).not.toContain('Write the message in English.');
    const en = buildCommitPrompt(summaryWith(), true, 'en');
    expect(en).not.toContain('Simplified Chinese');
  });
});

describe('buildCommitPrompt scope wording', () => {
  it('describes staged changes when the index is the scope', () => {
    const prompt = buildCommitPrompt(summaryWith({ stagedOnly: true }), true, 'en');
    expect(prompt).toContain('staged changes');
    expect(prompt).toContain('Scope: staged (index)');
  });

  it('describes working-tree changes when nothing is staged', () => {
    const prompt = buildCommitPrompt(summaryWith({ stagedOnly: false }), true, 'en');
    expect(prompt).toContain('working-tree changes');
    expect(prompt).toContain('Nothing is staged');
    expect(prompt).toContain('Scope: all uncommitted changes');
  });

  it('never claims the changes are staged in the unstaged case', () => {
    const prompt = buildCommitPrompt(summaryWith({ stagedOnly: false }), true, 'en');
    expect(prompt).not.toContain('staged changes below');
  });
});
