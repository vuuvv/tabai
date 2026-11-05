import { describe, expect, it } from 'vitest';
import {
  QWEN_FIM_TOKENS,
  STARCODER_FIM_TOKENS,
  buildChatSystemPrompt,
  buildChatUserPrompt,
  buildCommitPrompt,
  buildFimPrompt,
  buildFimStopSequences,
  languageNameFor,
  trimLines,
} from '../../src/ai/prompts.js';
import type { CompletionContext, GitDiffSummary } from '../../src/core/types.js';

/**
 * Builds a completion context with sensible defaults.
 *
 * @param overrides Fields to override.
 * @returns A complete context object.
 */
function contextWith(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    document: {
      uri: 'file:///a.ts',
      languageId: 'typescript',
      version: 1,
      text: 'const a = 1;\n',
      fileName: 'a.ts',
    },
    position: { line: 0, character: 12 },
    prefix: 'const a = ',
    suffix: ';\n',
    currentLine: 'const a = ;',
    isMiddleOfLine: false,
    imports: [],
    neighbors: [],
    ...overrides,
  };
}

describe('buildFimPrompt', () => {
  it('places the suffix before the middle marker', () => {
    const prompt = buildFimPrompt('PREFIX', 'SUFFIX');
    expect(prompt).toBe(
      QWEN_FIM_TOKENS.prefix + 'PREFIX' + QWEN_FIM_TOKENS.suffix + 'SUFFIX' + QWEN_FIM_TOKENS.middle,
    );
  });

  it('uses the Qwen sentinels by default', () => {
    expect(buildFimPrompt('a', 'b')).toContain('<|fim_prefix|>');
    expect(buildFimPrompt('a', 'b')).toContain('<|fim_middle|>');
  });

  it('supports the StarCoder sentinel family', () => {
    const prompt = buildFimPrompt('a', 'b', STARCODER_FIM_TOKENS);
    expect(prompt).toContain('<fim_prefix>');
    expect(prompt).not.toContain('<|fim_prefix|>');
  });

  it('handles empty prefix and suffix', () => {
    const prompt = buildFimPrompt('', '');
    expect(prompt).toBe(
      QWEN_FIM_TOKENS.prefix + QWEN_FIM_TOKENS.suffix + QWEN_FIM_TOKENS.middle,
    );
  });
});

describe('buildFimStopSequences', () => {
  it('always stops on pad, end-of-text and both FIM sentinels', () => {
    const stops = buildFimStopSequences();
    expect(stops).toContain(QWEN_FIM_TOKENS.pad);
    expect(stops).toContain(QWEN_FIM_TOKENS.endOfText);
    expect(stops).toContain(QWEN_FIM_TOKENS.prefix);
    expect(stops).toContain(QWEN_FIM_TOKENS.suffix);
  });

  it('adds a double newline stop when multiline is disabled', () => {
    expect(buildFimStopSequences(undefined, false)).toContain('\n\n');
  });

  it('does not add the newline stop when multiline is enabled', () => {
    expect(buildFimStopSequences(undefined, true)).not.toContain('\n\n');
  });
});

describe('trimLines', () => {
  it('returns short text unchanged', () => {
    expect(trimLines('a\nb', 10, true)).toBe('a\nb');
  });

  it('keeps the tail when asked', () => {
    expect(trimLines('1\n2\n3\n4', 2, true)).toBe('3\n4');
  });

  it('keeps the head when asked', () => {
    expect(trimLines('1\n2\n3\n4', 2, false)).toBe('1\n2');
  });

  it('returns an empty string for a zero limit', () => {
    expect(trimLines('a\nb', 0, true)).toBe('');
  });

  it('floors a fractional limit', () => {
    expect(trimLines('1\n2\n3', 2.9, false)).toBe('1\n2');
  });
});

describe('languageNameFor', () => {
  it('maps known VS Code language ids', () => {
    expect(languageNameFor('typescriptreact')).toBe('TypeScript React');
    expect(languageNameFor('cpp')).toBe('C++');
    expect(languageNameFor('csharp')).toBe('C#');
    expect(languageNameFor('shellscript')).toBe('Shell');
  });

  it('passes unknown ids through', () => {
    expect(languageNameFor('brainfuck')).toBe('brainfuck');
  });
});

describe('buildChatSystemPrompt', () => {
  it('mentions the language and the file name', () => {
    const prompt = buildChatSystemPrompt(contextWith(), true);
    expect(prompt).toContain('TypeScript');
    expect(prompt).toContain('a.ts');
  });

  it('forbids prose and fences', () => {
    const prompt = buildChatSystemPrompt(contextWith(), true);
    expect(prompt).toContain('ONLY the raw code');
    expect(prompt).toContain('no markdown fences');
  });

  it('allows multiline output when enabled', () => {
    expect(buildChatSystemPrompt(contextWith(), true)).toContain('multiple lines');
  });

  it('restricts to one line when disabled', () => {
    expect(buildChatSystemPrompt(contextWith(), false)).toContain('at most one line');
  });
});

describe('buildChatUserPrompt', () => {
  it('wraps the prefix and suffix in markers', () => {
    const prompt = buildChatUserPrompt(contextWith());
    expect(prompt).toContain('<CODE_BEFORE_CURSOR>');
    expect(prompt).toContain('const a = ');
    expect(prompt).toContain('<CURSOR>');
    expect(prompt).toContain('<CODE_AFTER_CURSOR>');
  });
});

describe('buildCommitPrompt', () => {
  /**
   * Builds a diff summary for prompt tests.
   *
   * @returns A summary with two changed files.
   */
  function summary(): GitDiffSummary {
    return {
      repoRoot: '/repo',
      branch: 'main',
      files: [
        { path: 'src/a.ts', status: 'M', insertions: 3, deletions: 1 },
        { path: 'src/b.ts', status: 'A', insertions: 10, deletions: 0 },
      ],
      diff: 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1;',
      truncated: false,
    stagedOnly: false,
    };
  }

  it('lists every changed file with its counts', () => {
    const prompt = buildCommitPrompt(summary(), true, 'en');
    expect(prompt).toContain('M src/a.ts (+3/-1)');
    expect(prompt).toContain('A src/b.ts (+10/-0)');
  });

  it('includes the branch name', () => {
    expect(buildCommitPrompt(summary(), true, 'en')).toContain('Branch: main');
  });

  it('requests Conventional Commits when enabled', () => {
    const prompt = buildCommitPrompt(summary(), true, 'en');
    expect(prompt).toContain('Conventional Commits');
    expect(prompt).toContain('feat, fix, docs');
  });

  it('omits the Conventional Commits rules when disabled', () => {
    const prompt = buildCommitPrompt(summary(), false, 'en');
    expect(prompt).not.toContain('Conventional Commits');
    expect(prompt).toContain('imperative mood');
  });

  it('asks for Chinese output when configured', () => {
    expect(buildCommitPrompt(summary(), true, 'zh-CN')).toContain('Simplified Chinese');
  });

  it('asks for English output by default', () => {
    expect(buildCommitPrompt(summary(), true, 'en')).toContain('Write the message in English');
  });

  it('flags a truncated diff', () => {
    const truncated = { ...summary(), truncated: true };
    expect(buildCommitPrompt(truncated, true, 'en')).toContain('Diff (truncated):');
  });

  it('includes the diff body', () => {
    expect(buildCommitPrompt(summary(), true, 'en')).toContain('+const x = 1;');
  });
});
