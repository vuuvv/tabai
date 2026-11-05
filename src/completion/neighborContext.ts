/**
 * Cross-file context collection.
 *
 * Inline completion is much better when the model can see how the rest of the
 * project writes similar code: the same helper implemented elsewhere, the
 * class this file mirrors, the import that was copied between modules.
 *
 * This module builds that context without an index server. It scans a bounded
 * set of files, slides a window over each, ranks the windows by Jaccard
 * similarity to the code around the cursor, and returns the best few. The
 * whole pass is budgeted so it stays cheap enough to run per keystroke.
 */

import { logger } from '../core/logger.js';
import type { NeighborCandidate, NeighborSnippet } from './similarity.js';
import {
  selectNeighborSnippets,
  splitIntoWindows,
  windowAround,
} from './similarity.js';

/**
 * A file the collector is allowed to read.
 *
 * The caller (the VS Code adapter) supplies these, which keeps this module
 * free of any filesystem or editor API.
 */
export interface SourceFile {
  /** Repository-relative path, used for display and de-duplication. */
  path: string;
  /** Full file content. */
  text: string;
}

/** Options for {@link collectNeighborContext}. */
export interface NeighborContextOptions {
  /** Repository-relative path of the file being edited; excluded from results. */
  currentPath: string;
  /** Code around the cursor used as the similarity query. */
  query: string;
  /** Minimum similarity to keep a snippet. */
  threshold: number;
  /** Maximum number of snippets to return. */
  maxSnippets: number;
  /** Maximum characters per snippet. */
  maxSnippetChars: number;
  /** Maximum total characters across all snippets. */
  maxTotalChars: number;
  /** Lines per sliding window. */
  windowLines: number;
  /** Maximum files to scan, newest/most relevant first. */
  maxFiles: number;
  /** Maximum characters read from any single file. */
  maxFileChars: number;
}

/**
 * The default options, tuned to stay under a few milliseconds of CPU for a
 * typical repository.
 */
export const DEFAULT_NEIGHBOR_OPTIONS: Omit<NeighborContextOptions, 'currentPath' | 'query'> = {
  threshold: 0.1,
  maxSnippets: 3,
  maxSnippetChars: 2000,
  maxTotalChars: 4000,
  windowLines: 40,
  maxFiles: 20,
  maxFileChars: 100000,
};

/**
 * Collects the most similar snippets from files other than the current one.
 *
 * The function never throws: a malformed or huge file is skipped rather than
 * failing the completion request.
 *
 * @param files Candidate files, already ordered by relevance by the caller.
 * @param options Collection limits.
 * @returns Snippets ordered by descending similarity.
 */
export function collectNeighborContext(
  files: SourceFile[],
  options: NeighborContextOptions,
): NeighborSnippet[] {
  if (options.query.trim().length === 0) {
    return [];
  }

  const candidates: NeighborCandidate[] = [];
  let scanned = 0;

  for (const file of files) {
    if (scanned >= options.maxFiles) {
      break;
    }
    if (file.path === options.currentPath) {
      continue;
    }
    if (file.text.length === 0) {
      continue;
    }
    scanned += 1;

    const text =
      file.text.length > options.maxFileChars
        ? file.text.slice(0, options.maxFileChars)
        : file.text;

    let windows: { text: string; startLine: number }[];
    try {
      windows = splitIntoWindows(text, options.windowLines);
    } catch (error) {
      logger.debug('neighbor: failed to window ' + file.path + ': ' + String(error));
      continue;
    }

    for (const window of windows) {
      candidates.push({ path: file.path, content: window.text, startLine: window.startLine });
    }
  }

  const selected = selectNeighborSnippets(options.query, candidates, {
    threshold: options.threshold,
    maxSnippets: options.maxSnippets,
    maxSnippetChars: options.maxSnippetChars,
    maxTotalChars: options.maxTotalChars,
  });

  if (selected.length > 0) {
    logger.debug(
      'neighbor: ' +
        selected.length +
        ' snippet(s) from ' +
        new Set(selected.map((snippet) => snippet.path)).size +
        ' file(s), best score=' +
        selected[0]?.score.toFixed(3),
    );
  } else {
    logger.debug('neighbor: no snippet above threshold ' + options.threshold);
  }

  return selected;
}

/**
 * Builds the query window used for similarity matching.
 *
 * The code immediately around the cursor is the best predictor of what the
 * model needs, so a narrow window is used rather than the whole file.
 *
 * @param documentText Full text of the file being edited.
 * @param cursorLine The line the cursor sits on.
 * @param radius Lines on each side.
 * @returns The query text.
 */
export function buildQueryWindow(
  documentText: string,
  cursorLine: number,
  radius = 20,
): string {
  return windowAround(documentText.split('\n'), cursorLine, radius).text;
}

/**
 * Formats neighbour snippets into a prompt block.
 *
 * Each snippet is labelled with its path and starting line so the model can
 * attribute the code, and so the reader of a debug log can tell where a
 * suggestion came from.
 *
 * @param snippets Snippets returned by {@link collectNeighborContext}.
 * @returns A prompt-ready string, or an empty string when there are none.
 */
export function formatNeighborContext(snippets: NeighborSnippet[]): string {
  if (snippets.length === 0) {
    return '';
  }
  const blocks = snippets.map((snippet) => {
    const header = '# ' + snippet.path + ' (line ' + (snippet.startLine + 1) + ')';
    return header + '\n' + snippet.content;
  });
  return blocks.join('\n\n');
}
