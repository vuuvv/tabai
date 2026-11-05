/**
 * Repository inspection helpers for commit message generation.
 *
 * These functions are pure: they take the raw output of git commands and turn
 * it into the structured {@link GitDiffSummary} the prompt builder consumes.
 * The process spawning lives in `gitService.ts` so this file stays testable.
 */

import type { GitDiffSummary, GitFileChange } from '../core/types.js';

/**
 * Parses `git status --porcelain=v1 -z` output into file changes.
 *
 * The `-z` form uses NUL separators so paths with spaces survive intact.
 * Renames consume two records: the new path followed by the old path.
 *
 * @param stdout Raw porcelain output.
 * @returns One entry per changed file.
 */
export function parsePorcelainStatus(stdout: string): GitFileChange[] {
  const records = stdout.split('\0').filter((entry) => entry.length > 0);
  const changes: GitFileChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record.length < 4) {
      continue;
    }
    const indexStatus = record.charAt(0);
    const workTreeStatus = record.charAt(1);
    const path = record.slice(3);

    // A rename or copy record is followed by the original path; skip it.
    const isRenameOrCopy = indexStatus === 'R' || indexStatus === 'C';
    if (isRenameOrCopy) {
      index += 1;
    }

    const status = normaliseStatusCode(indexStatus, workTreeStatus);
    changes.push({ path, status, insertions: 0, deletions: 0 });
  }

  return changes;
}

/**
 * Parses `git diff --cached --name-status -z` output.
 *
 * The stream alternates a status letter and a path, both NUL-terminated.
 * Rename and copy records (`R`/`C`) insert the original path as a third
 * field, which must be consumed so the next record is read correctly.
 *
 * @param stdout Raw name-status output.
 * @returns One entry per staged file.
 */
export function parseNameStatus(stdout: string): GitFileChange[] {
  if (stdout.length === 0) {
    return [];
  }
  const fields = stdout.split('\0');
  const changes: GitFileChange[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const rawStatus = fields[index] ?? '';
    if (rawStatus.length === 0) {
      continue;
    }
    const path = fields[index + 1] ?? '';
    index += 1;
    if (path.length === 0) {
      continue;
    }
    const letter = rawStatus.charAt(0);
    if (letter === 'R' || letter === 'C') {
      index += 1;
    }
    changes.push({
      path,
      status: normaliseStatusCode(letter, ' '),
      insertions: 0,
      deletions: 0,
    });
  }

  return changes;
}

/**
 * Collapses the two porcelain status columns into a single code.
 *
 * @param indexStatus Status in the staging area.
 * @param workTreeStatus Status in the working tree.
 * @returns A single-letter code suitable for display.
 */
export function normaliseStatusCode(indexStatus: string, workTreeStatus: string): string {
  const isUntracked = indexStatus === '?' && workTreeStatus === '?';
  if (isUntracked) {
    return 'A';
  }
  if (indexStatus === 'U' || workTreeStatus === 'U') {
    return 'U';
  }
  if (indexStatus === 'D' || workTreeStatus === 'D') {
    return 'D';
  }
  if (indexStatus === 'R') {
    return 'R';
  }
  if (indexStatus === 'A') {
    return 'A';
  }
  if (indexStatus === 'M' || workTreeStatus === 'M') {
    return 'M';
  }
  const first = indexStatus.trim().length > 0 ? indexStatus : workTreeStatus;
  return first.trim().length > 0 ? first : 'M';
}

/**
 * Parses `git diff --numstat` output and merges the counts into the file list.
 *
 * Binary files report `-` for both counts; those are treated as zero so the
 * prompt can still mention the file.
 *
 * @param stdout Raw numstat output.
 * @param files File list to enrich; matched by path.
 * @returns A new array with insertions and deletions filled in.
 */
export function applyNumstat(stdout: string, files: GitFileChange[]): GitFileChange[] {
  const counts = new Map<string, { insertions: number; deletions: number }>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split('\t');
    if (parts.length < 3) {
      continue;
    }
    const insertions = Number.parseInt(parts[0] ?? '', 10);
    const deletions = Number.parseInt(parts[1] ?? '', 10);
    const path = parts.slice(2).join('\t');
    counts.set(path, {
      insertions: Number.isFinite(insertions) ? insertions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }

  return files.map((file) => {
    const entry = counts.get(file.path);
    if (entry === undefined) {
      return file;
    }
    return { ...file, insertions: entry.insertions, deletions: entry.deletions };
  });
}

/**
 * Truncates a diff to a character budget, keeping the beginning.
 *
 * Diffs are ordered by file so the head of the diff still describes most of
 * the change set; keeping the head is more informative than keeping the tail.
 *
 * @param diff The full diff text.
 * @param maxChars Maximum number of characters to keep.
 * @returns The possibly truncated diff and whether truncation happened.
 */
export function truncateDiff(
  diff: string,
  maxChars: number,
): { diff: string; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maxChars));
  if (limit === 0) {
    return { diff: '', truncated: diff.length > 0 };
  }
  if (diff.length <= limit) {
    return { diff, truncated: false };
  }
  // Cut at the last newline before the limit so the diff stays syntactically
  // valid up to that point rather than ending mid-line.
  const slice = diff.slice(0, limit);
  const lastNewline = slice.lastIndexOf('\n');
  const cut = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
  return { diff: cut, truncated: true };
}

/**
 * Counts the total added and removed lines in a unified diff.
 *
 * @param diff Unified diff text.
 * @returns Aggregate line counts.
 */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * Builds a {@link GitDiffSummary} from raw git outputs.
 *
 * @param params Raw command outputs and repository metadata.
 * @returns The structured summary.
 */
export function buildDiffSummary(params: {
  repoRoot: string;
  branch: string;
  porcelainStdout: string;
  numstatStdout: string;
  diffStdout: string;
  maxDiffChars: number;
  /** Pre-parsed file list; takes precedence over `porcelainStdout`. */
  fileList?: GitFileChange[];
  /** True when the summary describes the index only. */
  stagedOnly?: boolean;
}): GitDiffSummary {
  const parsed =
    params.fileList !== undefined
      ? params.fileList
      : parsePorcelainStatus(params.porcelainStdout);
  const files = applyNumstat(params.numstatStdout, parsed);
  const truncatedResult = truncateDiff(params.diffStdout, params.maxDiffChars);
  return {
    repoRoot: params.repoRoot,
    branch: params.branch,
    files,
    diff: truncatedResult.diff,
    truncated: truncatedResult.truncated,
    stagedOnly: params.stagedOnly ?? false,
  };
}
