/**
 * Prompt construction for the two provider protocols.
 *
 * The shapes here are derived from the reference implementation: a FIM request
 * is a plain text prompt wrapped in model-specific sentinel tokens, while the
 * chat variant sends a compact system instruction plus the code context.
 */

import type { CompletionContext, GitDiffSummary } from '../core/types.js';

/**
 * Sentinel tokens for the Qwen / StarCoder family of FIM models.
 *
 * These are the tokens LM Studio's Qwen build was verified against: sending
 * them raw produces a clean single-line continuation, while the plain-text
 * variant makes the model continue past the cursor and hallucinate new
 * functions.
 */
export const QWEN_FIM_TOKENS = {
  /** Marks the start of the prefix. */
  prefix: '<|fim_prefix|>',
  /** Marks the boundary between prefix and suffix. */
  suffix: '<|fim_suffix|>',
  /** Marks the point the model must fill in. */
  middle: '<|fim_middle|>',
  /** Padding token emitted by some builds; used as a stop sequence. */
  pad: '<|fim_pad|>',
  /** End-of-text sentinel; used as a stop sequence. */
  endOfText: '<|endoftext|>',
} as const;

/** Sentinel tokens used by the StarCoder / CodeLlama FIM family. */
export const STARCODER_FIM_TOKENS = {
  /** Marks the start of the prefix. */
  prefix: '<fim_prefix>',
  /** Marks the boundary between prefix and suffix. */
  suffix: '<fim_suffix>',
  /** Marks the point the model must fill in. */
  middle: '<fim_middle>',
  /** Padding token emitted by some builds; used as a stop sequence. */
  pad: '<fim_pad>',
  /** End-of-text sentinel; used as a stop sequence. */
  endOfText: '<|endoftext|>',
} as const;

/** The set of sentinel tokens for one model family. */
export type FimTokens = typeof QWEN_FIM_TOKENS | typeof STARCODER_FIM_TOKENS;

/**
 * Builds the raw FIM prompt string.
 *
 * Layout: `<prefix>PRE<|fim_suffix|>SUF<|fim_middle|>`. The suffix comes
 * before the middle marker because that is the contract of the FIM training
 * objective; the model then continues from the middle marker.
 *
 * @param prefix Text before the cursor.
 * @param suffix Text after the cursor.
 * @param tokens Sentinel token set, defaults to the Qwen family.
 * @returns The assembled prompt.
 */
export function buildFimPrompt(
  prefix: string,
  suffix: string,
  tokens: FimTokens = QWEN_FIM_TOKENS,
  neighborContext = '',
): string {
  // Neighbour snippets go *before* the prefix. FIM models are trained to
  // continue from the prefix, so anything placed after it would be treated as
  // code to continue rather than reference material.
  const preamble =
    neighborContext.length > 0
      ? '// Related code from this project:\n' + neighborContext + '\n\n'
      : '';
  return tokens.prefix + preamble + prefix + tokens.suffix + suffix + tokens.middle;
}

/**
 * Formats cross-file snippets for inclusion in a prompt.
 *
 * @param neighbors Snippets collected from other files.
 * @returns A labelled block, or an empty string when there are none.
 */
export function formatNeighborBlock(
  neighbors: { path: string; content: string; startLine: number; score: number }[],
): string {
  if (neighbors.length === 0) {
    return '';
  }
  return neighbors
    .map(
      (snippet) =>
        '// ' +
        snippet.path +
        ' (line ' +
        (snippet.startLine + 1) +
        ')\n' +
        snippet.content,
    )
    .join('\n\n');
}

/**
 * Builds the stop sequences for a FIM request.
 *
 * Generation must stop as soon as the model tries to emit a sentinel or to
 * start a brand new top-level declaration, otherwise a completion can bleed
 * into unrelated code.
 *
 * @param tokens Sentinel token set.
 * @param multiline Whether multi-line output is allowed.
 * @returns An array of stop strings.
 */
export function buildFimStopSequences(
  tokens: FimTokens = QWEN_FIM_TOKENS,
  multiline = true,
): string[] {
  const stops: string[] = [tokens.pad, tokens.endOfText, tokens.prefix, tokens.suffix];
  if (!multiline) {
    stops.push('\n\n');
  }
  return stops;
}

/**
 * Trims a text block to at most `maxLines` lines.
 *
 * When the text is longer the *tail* is kept, because the code closest to the
 * cursor carries the most signal for a completion.
 *
 * @param text The text to trim.
 * @param maxLines Maximum number of lines to keep.
 * @param fromEnd True to keep the tail, false to keep the head.
 * @returns The trimmed text.
 */
export function trimLines(text: string, maxLines: number, fromEnd: boolean): string {
  const limit = Math.max(0, Math.floor(maxLines));
  if (limit === 0) {
    return '';
  }
  const lines = text.split('\n');
  if (lines.length <= limit) {
    return text;
  }
  return fromEnd ? lines.slice(-limit).join('\n') : lines.slice(0, limit).join('\n');
}

/**
 * Returns the language name to show the model.
 *
 * VS Code language ids such as `typescriptreact` are not meaningful to a
 * model, so they are mapped onto the names used in training corpora.
 *
 * @param languageId The VS Code language id.
 * @returns A human-readable language name.
 */
export function languageNameFor(languageId: string): string {
  const mapping: Record<string, string> = {
    typescript: 'TypeScript',
    typescriptreact: 'TypeScript React',
    javascript: 'JavaScript',
    javascriptreact: 'JavaScript React',
    python: 'Python',
    java: 'Java',
    go: 'Go',
    rust: 'Rust',
    cpp: 'C++',
    c: 'C',
    csharp: 'C#',
    ruby: 'Ruby',
    php: 'PHP',
    kotlin: 'Kotlin',
    swift: 'Swift',
    scala: 'Scala',
    sql: 'SQL',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    json: 'JSON',
    yaml: 'YAML',
    markdown: 'Markdown',
    shellscript: 'Shell',
  };
  return mapping[languageId] ?? languageId;
}

/**
 * Builds the system prompt used by the chat-completions protocol.
 *
 * The instructions are deliberately terse: the reference implementation relies
 * on a short, rigid instruction set plus strong post-processing rather than on
 * a long prompt, which keeps the prefill cheap.
 *
 * @param context The completion context.
 * @param multiline Whether multi-line completions are allowed.
 * @returns The system prompt string.
 */
export function buildChatSystemPrompt(
  context: CompletionContext,
  multiline: boolean,
): string {
  const language = languageNameFor(context.document.languageId);
  const rules = [
    'You are a code completion engine embedded in an editor.',
    'Complete the code at the <CURSOR> marker.',
    'Return ONLY the raw code to insert. No prose, no markdown fences, no explanation.',
    'Never repeat code that already appears before the cursor.',
    'Match the surrounding indentation style exactly.',
    'When related code from the project is provided, follow its naming, style and conventions.',
    multiline
      ? 'You may return multiple lines when the structure clearly calls for it.'
      : 'Return at most one line.',
    'If no useful completion exists, return an empty response.',
  ];
  return [
    'Language: ' + language + '.',
    'File: ' + context.document.fileName + '.',
    rules.join('\n'),
  ].join('\n\n');
}

/**
 * Builds the user message used by the chat-completions protocol.
 *
 * @param context The completion context.
 * @returns The user message string.
 */
export function buildChatUserPrompt(context: CompletionContext): string {
  const parts: string[] = [];
  const neighborBlock = formatNeighborBlock(context.neighbors ?? []);
  if (neighborBlock.length > 0) {
    parts.push(
      '<RELATED_CODE_FROM_PROJECT>',
      neighborBlock,
      '</RELATED_CODE_FROM_PROJECT>',
      '',
    );
  }
  parts.push(
    '<CODE_BEFORE_CURSOR>',
    context.prefix,
    '</CODE_BEFORE_CURSOR>',
    '<CURSOR>',
    '<CODE_AFTER_CURSOR>',
    context.suffix,
    '</CODE_AFTER_CURSOR>',
  );
  return parts.join('\n');
}

/**
 * Formats the git diff into a prompt-friendly summary.
 *
 * The diff is the single most informative artefact for commit messages, so it
 * dominates the prompt; the file list is included only as a compact index.
 *
 * @param summary Aggregated repository state.
 * @param conventionalCommits Whether to request a Conventional Commits subject.
 * @param language Output language of the message.
 * @returns The user prompt string.
 */
export function buildCommitPrompt(
  summary: GitDiffSummary,
  conventionalCommits: boolean,
  language: 'en' | 'zh-CN',
): string {
  const fileLines = summary.files
    .map((file) => file.status + ' ' + file.path + ' (+' + file.insertions + '/-' + file.deletions + ')')
    .join('\n');

  const formatRules = conventionalCommits
    ? [
        'Write a Conventional Commits message.',
        'Subject format: <type>(<scope>): <summary>',
        'Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
        'The subject must be imperative, lower-case after the colon, and at most 72 characters.',
      ]
    : [
        'Write a commit message whose subject line is at most 72 characters.',
        'Use the imperative mood.',
      ];

  const languageRule =
    language === 'zh-CN'
      ? 'Write the message in Simplified Chinese.'
      : 'Write the message in English.';

  const scopeLine = summary.stagedOnly
    ? 'Generate a commit message for the staged changes below.'
    : 'Generate a commit message for the working-tree changes below. ' +
      '(Nothing is staged, so these are all uncommitted changes.)';

  return [
    scopeLine,
    '',
    ...formatRules,
    languageRule,
    'Return the subject line first. If a body is genuinely useful, add one blank',
    'line and then short bullet points explaining what changed and why.',
    'Return plain text only: no markdown fences, no surrounding quotes.',
    '',
    'Branch: ' + summary.branch,
    'Scope: ' + (summary.stagedOnly ? 'staged (index)' : 'all uncommitted changes'),
    'Changed files (' + summary.files.length + '):',
    fileLines,
    '',
    'Diff' + (summary.truncated ? ' (truncated)' : '') + ':',
    summary.diff,
  ].join('\n');
}
