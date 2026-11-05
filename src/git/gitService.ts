/**
 * The git service.
 *
 * Wraps the subset of git the extension needs behind a small, injectable
 * interface. Process spawning is isolated in one method so tests can stub it
 * without spawning real processes.
 */

import { execFile } from 'node:child_process';
import type { GitDiffSummary } from '../core/types.js';
import { TabAIError } from '../core/types.js';
import { logger } from '../core/logger.js';
import { buildDiffSummary, parseNameStatus } from './diffSummary.js';

/** The result of one git invocation. */
export interface GitCommandResult {
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
  /** Process exit code. */
  code: number;
}

/**
 * A function that runs a git subcommand.
 *
 * Mirrors `child_process.execFile` closely enough to be swappable in tests.
 */
export type GitRunner = (
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<GitCommandResult>;

/**
 * The default runner, backed by `execFile`.
 *
 * Never rejects on a non-zero exit code; the caller decides whether that is an
 * error. Rejections are reserved for spawn failures.
 *
 * @param args Arguments passed to git.
 * @param cwd Working directory.
 * @param timeoutMs Timeout in milliseconds.
 * @returns The captured output and exit code.
 */
export const defaultGitRunner: GitRunner = (args, cwd, timeoutMs) =>
  new Promise<GitCommandResult>((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null && typeof error === 'object' && 'code' in error) {
          const rawCode = (error as { code?: unknown }).code;
          if (typeof rawCode === 'number') {
            resolve({ stdout, stderr, code: rawCode });
            return;
          }
          // `code: 'ENOENT'` means git is not installed.
          reject(
            new TabAIError('not-configured', 'git executable not found: ' + String(rawCode), {
              cause: error,
            }),
          );
          return;
        }
        if (error !== null) {
          resolve({ stdout, stderr, code: 1 });
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
  });

/** Options for {@link GitService}. */
export interface GitServiceOptions {
  /** Injected runner, used by tests. */
  runner?: GitRunner;
  /** Timeout applied to each git command. */
  timeoutMs?: number;
}

/**
 * Reads repository state through git.
 *
 * All methods resolve repository-relative paths against the supplied working
 * directory, so a multi-root workspace works by constructing one service per
 * root.
 */
export class GitService {
  /** Runner used for every command. */
  private readonly runner: GitRunner;

  /** Per-command timeout. */
  private readonly timeoutMs: number;

  /**
   * @param options Optional dependency injection.
   */
  public constructor(options: GitServiceOptions = {}) {
    this.runner = options.runner ?? defaultGitRunner;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  /**
   * Runs one git command and throws when it fails.
   *
   * @param args Arguments passed to git.
   * @param cwd Working directory.
   * @returns Standard output.
   * @throws TabAIError when git exits non-zero.
   */
  private async runOrThrow(args: string[], cwd: string): Promise<string> {
    const result = await this.runner(args, cwd, this.timeoutMs);
    if (result.code !== 0) {
      throw new TabAIError(
        'http',
        'git ' + args.join(' ') + ' failed: ' + result.stderr.trim(),
        { statusCode: result.code },
      );
    }
    return result.stdout;
  }

  /**
   * Returns the absolute path of the repository root containing a directory.
   *
   * @param cwd A directory inside the repository.
   * @returns The repository root, or `null` when not inside a repository.
   */
  public async getRepoRoot(cwd: string): Promise<string | null> {
    const result = await this.runner(['rev-parse', '--show-toplevel'], cwd, this.timeoutMs);
    if (result.code !== 0) {
      return null;
    }
    const root = result.stdout.trim();
    return root.length === 0 ? null : root;
  }

  /**
   * Returns the current branch name.
   *
   * @param repoRoot Repository root.
   * @returns The branch name, or `HEAD` when detached.
   */
  public async getBranch(repoRoot: string): Promise<string> {
    const result = await this.runner(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, this.timeoutMs);
    if (result.code !== 0) {
      return 'HEAD';
    }
    const branch = result.stdout.trim();
    return branch.length === 0 ? 'HEAD' : branch;
  }

  /**
   * Returns true when the repository has at least one commit.
   *
   * A freshly initialised repository has no `HEAD`, and `git diff HEAD` fails
   * there, so the caller needs to know before choosing a diff command.
   *
   * @param repoRoot Repository root.
   * @returns True when `HEAD` resolves to a commit.
   */
  public async hasCommits(repoRoot: string): Promise<boolean> {
    const result = await this.runner(['rev-parse', '--verify', 'HEAD'], repoRoot, this.timeoutMs);
    return result.code === 0;
  }

  /**
   * Collects the repository state used to build a commit prompt.
   *
   * Scope selection: when the index has staged changes only those are
   * described, because that is exactly what the next commit would contain.
   * When nothing is staged every working-tree change is described instead,
   * matching what `git commit -a` would pick up.
   *
   * @param cwd A directory inside the repository.
   * @param maxDiffChars Character budget for the diff.
   * @returns The aggregated summary, or `null` when there is nothing to commit.
   * @throws TabAIError when `cwd` is not inside a repository.
   */
  public async collectSummary(cwd: string, maxDiffChars: number): Promise<GitDiffSummary | null> {
    const repoRoot = await this.getRepoRoot(cwd);
    if (repoRoot === null) {
      throw new TabAIError('not-configured', 'The workspace is not inside a git repository');
    }

    const branch = await this.getBranch(repoRoot);
    const hasCommits = await this.hasCommits(repoRoot);
    const stagedOnly = await this.hasStagedChanges(repoRoot);

    // The index is the source of truth when something is staged: describe the
    // staged content only, so the message matches the commit being created.
    const numstatArgs = stagedOnly
      ? ['diff', '--cached', '--numstat', '--']
      : ['diff', '--numstat', 'HEAD', '--'];
    const diffArgs = stagedOnly
      ? ['diff', '--cached', '--no-color', '--unified=3', '--']
      : hasCommits
        ? ['diff', 'HEAD', '--no-color', '--unified=3', '--']
        : ['diff', '--cached', '--no-color', '--unified=3', '--'];

    // For the staged case, `--name-status` is authoritative: porcelain would
    // also list unstaged edits to the same paths plus untracked files.
    const nameStatusStdout = stagedOnly
      ? await this.runOrThrow(['diff', '--cached', '--name-status', '-z', '--'], repoRoot).catch(
          () => '',
        )
      : '';

    // In the staged case `--name-status` is the single source of truth. Never
    // fall back to porcelain there: porcelain also reports unstaged edits to
    // the same paths plus untracked files, which must not appear in a message
    // describing the index. An empty list simply means nothing to summarise.
    const useNameStatus = stagedOnly;
    const porcelainStdout = stagedOnly
      ? ''
      : await this.runOrThrow(
          ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
          repoRoot,
        );

    if (!stagedOnly && porcelainStdout.trim().length === 0) {
      logger.debug('no changes to summarise');
      return null;
    }

    const numstatStdout = await this.runOrThrow(numstatArgs, repoRoot).catch(() => '');
    const diffStdout = await this.runOrThrow(diffArgs, repoRoot).catch(() => '');

    const summary = buildDiffSummary({
      repoRoot,
      branch,
      porcelainStdout,
      numstatStdout,
      diffStdout,
      maxDiffChars,
      ...(useNameStatus ? { fileList: parseNameStatus(nameStatusStdout) } : {}),
    });

    if (!stagedOnly) {
      // Untracked files never appear in a diff; append a synthetic hunk so the
      // model at least knows they exist and can name them in the message.
      const untracked = summary.files.filter(
        (file) => file.status === 'A' && file.insertions === 0,
      );
      if (untracked.length > 0) {
        const listing = untracked.map((file) => 'new file: ' + file.path).join('\n');
        summary.diff = (summary.diff + '\n' + listing).trim();
      }
    }

    summary.stagedOnly = stagedOnly;

    if (summary.files.length === 0) {
      logger.debug('no files in scope for the commit message');
      return null;
    }

    logger.debug(
      'collected ' +
        summary.files.length +
        ' file(s) on branch ' +
        branch +
        ' scope=' +
        (stagedOnly ? 'staged' : 'all-changes'),
    );
    return summary;
  }

  /**
   * Returns true when the index differs from `HEAD`.
   *
   * `git diff --cached --quiet` reports the answer through its exit code: 0
   * means identical, 1 means differences. Any other code (a repository without
   * commits, for instance) falls back to listing the index directly.
   *
   * @param repoRoot Repository root.
   * @returns True when at least one change is staged.
   */
  public async hasStagedChanges(repoRoot: string): Promise<boolean> {
    const quiet = await this.runner(
      ['diff', '--cached', '--quiet'],
      repoRoot,
      this.timeoutMs,
    );
    if (quiet.code === 1) {
      return true;
    }
    if (quiet.code === 0) {
      return false;
    }
    const listed = await this.runner(
      ['diff', '--cached', '--name-only'],
      repoRoot,
      this.timeoutMs,
    );
    return listed.code === 0 && listed.stdout.trim().length > 0;
  }

  /**
   * Stages every change in the repository.
   *
   * @param repoRoot Repository root.
   */
  public async stageAll(repoRoot: string): Promise<void> {
    await this.runOrThrow(['add', '--all'], repoRoot);
  }

  /**
   * Creates a commit with the given message.
   *
   * The message is passed via `-F -` on stdin-free `-m` arguments: each
   * paragraph becomes its own `-m` so git preserves the blank line.
   *
   * @param repoRoot Repository root.
   * @param message The full commit message.
   * @returns Standard output of the commit command.
   */
  public async commit(repoRoot: string, message: string): Promise<string> {
    const paragraphs = message
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const args = ['commit'];
    for (const paragraph of paragraphs) {
      args.push('-m', paragraph);
    }
    return this.runOrThrow(args, repoRoot);
  }
}
