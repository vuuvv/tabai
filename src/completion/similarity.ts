/**
 * Text similarity helpers for cross-file context retrieval.
 *
 * When a completion is requested, the surrounding code often already exists in
 * another file of the same project: a helper with the same name, a similar
 * class, an import that was copied between modules. Feeding those snippets to
 * the model lets it follow the project's conventions instead of inventing new
 * ones.
 *
 * The reference implementation uses Jaccard similarity over token sets with a
 * sliding window over neighbouring files. This module implements the same
 * idea, deliberately without any dependency so it can run per keystroke.
 */

/**
 * Splits text into comparable tokens.
 *
 * Identifiers are kept whole (so `calculateTotal` and `calculateTotal` match),
 * and identifiers are additionally split on camelCase and underscores so
 * `calculateTotal` and `calculate_total` are considered related. Keywords and
 * punctuation are dropped because they appear everywhere and carry no signal.
 *
 * @param text Source text.
 * @returns A set of normalised tokens.
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const identifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match: RegExpExecArray | null;
  while ((match = identifierPattern.exec(text)) !== null) {
    const identifier = match[0];
    if (identifier.length < 3) {
      continue;
    }
    tokens.add(identifier.toLowerCase());

    // Split camelCase and snake_case into component words.
    const parts = identifier
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_$]+/g, ' ')
      .toLowerCase()
      .split(/\s+/);
    for (const part of parts) {
      if (part.length >= 3) {
        tokens.add(part);
      }
    }
  }
  return tokens;
}

/**
 * Computes the Jaccard similarity between two token sets.
 *
 * @param a First token set.
 * @param b Second token set.
 * @returns A value in `[0, 1]`; 0 when either set is empty.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (large.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Computes the similarity between two raw text blocks.
 *
 * @param a First text.
 * @param b Second text.
 * @returns A value in `[0, 1]`.
 */
export function textSimilarity(a: string, b: string): number {
  return jaccard(tokenize(a), tokenize(b));
}

/**
 * A candidate snippet drawn from another file.
 */
export interface NeighborCandidate {
  /** Repository-relative path of the file. */
  path: string;
  /** The snippet text. */
  content: string;
  /** Zero-based line where the snippet starts in its file. */
  startLine: number;
}

/**
 * A snippet that passed the similarity threshold.
 */
export interface NeighborSnippet extends NeighborCandidate {
  /** Jaccard similarity against the query window, in `[0, 1]`. */
  score: number;
}

/** Options for {@link selectNeighborSnippets}. */
export interface SelectOptions {
  /** Minimum similarity to keep a snippet. */
  threshold: number;
  /** Maximum number of snippets to return. */
  maxSnippets: number;
  /** Maximum characters per snippet. */
  maxSnippetChars: number;
  /** Maximum total characters across all snippets. */
  maxTotalChars: number;
}

/**
 * Ranks candidate snippets by similarity and keeps the best ones.
 *
 * Ties are broken by shorter content, because a short highly-similar snippet
 * is more useful to a model than a long one that happens to score the same.
 *
 * @param query The code around the cursor.
 * @param candidates Snippets collected from other files.
 * @param options Selection limits.
 * @returns The selected snippets, best first.
 */
export function selectNeighborSnippets(
  query: string,
  candidates: NeighborCandidate[],
  options: SelectOptions,
): NeighborSnippet[] {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) {
    return [];
  }

  const scored: NeighborSnippet[] = [];
  for (const candidate of candidates) {
    const content =
      candidate.content.length > options.maxSnippetChars
        ? candidate.content.slice(0, options.maxSnippetChars)
        : candidate.content;
    if (content.trim().length === 0) {
      continue;
    }
    const score = jaccard(queryTokens, tokenize(content));
    if (score < options.threshold) {
      continue;
    }
    scored.push({ ...candidate, content, score });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.content.length - right.content.length;
  });

  const selected: NeighborSnippet[] = [];
  let total = 0;
  for (const snippet of scored) {
    if (selected.length >= options.maxSnippets) {
      break;
    }
    if (total + snippet.content.length > options.maxTotalChars) {
      continue;
    }
    selected.push(snippet);
    total += snippet.content.length;
  }
  return selected;
}

/**
 * Extracts a window of lines around a position.
 *
 * @param lines All lines of a file.
 * @param centerLine The line to centre the window on.
 * @param radius Number of lines on each side.
 * @returns The window text and its starting line index.
 */
export function windowAround(
  lines: string[],
  centerLine: number,
  radius: number,
): { text: string; startLine: number } {
  const safeRadius = Math.max(0, Math.floor(radius));
  const center = Math.min(Math.max(0, Math.floor(centerLine)), Math.max(0, lines.length - 1));
  const start = Math.max(0, center - safeRadius);
  const end = Math.min(lines.length, center + safeRadius + 1);
  return { text: lines.slice(start, end).join('\n'), startLine: start };
}

/**
 * Splits a file into overlapping windows for candidate generation.
 *
 * A neighbour file is not necessarily similar as a whole; the useful part is
 * usually one function. Sliding windows let the similarity check find that
 * function without needing an AST.
 *
 * @param text File content.
 * @param windowLines Lines per window.
 * @param strideLines Step between windows; defaults to half the window.
 * @returns Candidate snippets for the file.
 */
export function splitIntoWindows(
  text: string,
  windowLines: number,
  strideLines?: number,
): { text: string; startLine: number }[] {
  const size = Math.max(1, Math.floor(windowLines));
  const stride = Math.max(1, Math.floor(strideLines ?? Math.max(1, Math.floor(size / 2))));
  const lines = text.split('\n');
  if (lines.length === 0) {
    return [];
  }
  if (lines.length <= size) {
    return [{ text, startLine: 0 }];
  }
  const windows: { text: string; startLine: number }[] = [];
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(lines.length, start + size);
    windows.push({ text: lines.slice(start, end).join('\n'), startLine: start });
    if (end === lines.length) {
      break;
    }
  }
  return windows;
}
