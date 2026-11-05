/**
 * Context collection for completion requests.
 *
 * This module turns a document snapshot plus a cursor position into the
 * {@link CompletionContext} the provider consumes. It is deliberately free of
 * VS Code imports so it can be tested against plain strings.
 */

import type {
  CompletionContext,
  CursorPosition,
  DocumentSnapshot,
} from '../core/types.js';

/**
 * Converts a line/character position into a character offset.
 *
 * Positions past the end of the document clamp to the document length, which
 * mirrors what VS Code does for `document.offsetAt`.
 *
 * @param text The document text.
 * @param position The position to convert.
 * @returns A character offset into `text`.
 */
export function offsetAt(text: string, position: CursorPosition): number {
  const line = Math.max(0, Math.floor(position.line));
  const character = Math.max(0, Math.floor(position.character));

  let currentLine = 0;
  let offset = 0;
  while (currentLine < line && offset < text.length) {
    const nextBreak = text.indexOf('\n', offset);
    if (nextBreak === -1) {
      return text.length;
    }
    offset = nextBreak + 1;
    currentLine += 1;
  }
  return Math.min(text.length, offset + character);
}

/**
 * Extracts the text of one line, without the trailing newline.
 *
 * @param text The document text.
 * @param line Zero-based line number.
 * @returns The line content, or an empty string when the line does not exist.
 */
export function lineTextAt(text: string, line: number): string {
  const target = Math.max(0, Math.floor(line));
  const lines = text.split('\n');
  const value = lines[target];
  return value === undefined ? '' : value.replace(/\r$/, '');
}

/**
 * Extracts import-like statements from the beginning of the document.
 *
 * Only the first `maxImports` matches are returned and only the first 80
 * lines are scanned, which keeps the cost negligible on large files while
 * still surfacing the dependencies a completion is likely to need.
 *
 * @param text The document text.
 * @param maxImports Maximum number of statements to return.
 * @returns Matching import lines in document order.
 */
export function extractImports(text: string, maxImports = 20): string[] {
  const patterns = [
    /^\s*import\s.+$/,
    /^\s*from\s+\S+\s+import\s.+$/,
    /^\s*#include\s.+$/,
    /^\s*using\s+[\w.]+;\s*$/,
    /^\s*require\(.+$/,
    /^\s*const\s+\w+\s*=\s*require\(.+$/,
  ];
  const limit = Math.max(0, Math.floor(maxImports));
  if (limit === 0) {
    return [];
  }
  const results: string[] = [];
  const lines = text.split('\n').slice(0, 80);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (patterns.some((pattern) => pattern.test(line))) {
      results.push(line.trim());
      if (results.length >= limit) {
        break;
      }
    }
  }
  return results;
}

/**
 * Detects whether the cursor sits before real code on its line.
 *
 * A completion requested in the middle of a line is much more likely to be a
 * single token than a block, and some models produce badly indented output in
 * that position, so the engine treats it as a distinct case.
 *
 * @param text The document text.
 * @param position The cursor position.
 * @returns True when non-whitespace text follows the cursor on the same line.
 */
export function isMiddleOfLine(text: string, position: CursorPosition): boolean {
  const line = lineTextAt(text, position.line);
  const character = Math.max(0, Math.floor(position.character));
  return line.slice(character).trim().length > 0;
}

/**
 * Collects everything needed to issue a completion request.
 *
 * @param document Snapshot of the document.
 * @param position Cursor position.
 * @returns The assembled context.
 */
export function collectCompletionContext(
  document: DocumentSnapshot,
  position: CursorPosition,
): CompletionContext {
  const offset = offsetAt(document.text, position);
  return {
    document,
    position,
    prefix: document.text.slice(0, offset),
    suffix: document.text.slice(offset),
    currentLine: lineTextAt(document.text, position.line),
    isMiddleOfLine: isMiddleOfLine(document.text, position),
    imports: extractImports(document.text),
    neighbors: [],
  };
}
