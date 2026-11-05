/**
 * Commit message orchestration.
 *
 * Combines {@link GitService} and {@link AIClient} into the two user-facing
 * operations: generate a message, and generate-then-commit. Kept free of VS
 * Code imports so it can be driven entirely by fakes in tests.
 */

import type { CommitMessageResult, GitDiffSummary, TabAISettings } from '../core/types.js';
import { TabAIError } from '../core/types.js';
import { logger } from '../core/logger.js';
import type { AIClient } from '../ai/client.js';
import type { GitService } from './gitService.js';

/** The result of a generate-and-commit run. */
export interface CommitRunResult {
  /** The message that was generated. */
  generated: CommitMessageResult;
  /** The commit output reported by git, when a commit was made. */
  commitOutput: string | null;
}

/**
 * Generates commit messages and optionally commits.
 *
 * The service is stateless; all inputs arrive as arguments so a caller can
 * preview a message and only later decide to commit it.
 */
export class CommitService {
  /** Git access. */
  private readonly git: Pick<GitService, 'collectSummary' | 'stageAll' | 'commit'>;

  /** AI access. */
  private readonly client: Pick<AIClient, 'generateCommitMessage'>;

  /**
   * @param git Git service.
   * @param client AI client.
   */
  public constructor(
    git: Pick<GitService, 'collectSummary' | 'stageAll' | 'commit'>,
    client: Pick<AIClient, 'generateCommitMessage'>,
  ) {
    this.git = git;
    this.client = client;
  }

  /**
   * Collects the repository summary, throwing a friendly error when clean.
   *
   * @param cwd Directory inside the repository.
   * @param settings Settings snapshot.
   * @returns The repository summary.
   * @throws TabAIError when there is nothing to commit.
   */
  public async summarise(cwd: string, settings: TabAISettings): Promise<GitDiffSummary> {
    const summary = await this.git.collectSummary(cwd, settings.gitMaxDiffChars);
    if (summary === null) {
      throw new TabAIError('not-configured', 'There are no changes to commit');
    }
    return summary;
  }

  /**
   * Generates a commit message for the current changes.
   *
   * @param cwd Directory inside the repository.
   * @param settings Settings snapshot.
   * @param signal Optional abort signal.
   * @returns The generated message plus the summary it was based on.
   */
  public async generate(
    cwd: string,
    settings: TabAISettings,
    signal?: AbortSignal,
  ): Promise<{ generated: CommitMessageResult; summary: GitDiffSummary }> {
    const summary = await this.summarise(cwd, settings);
    logger.debug(
      'generating commit message for ' + summary.files.length + ' file(s)',
    );
    const generated = await this.client.generateCommitMessage(
      settings,
      summary,
      signal,
    );
    return { generated, summary };
  }

  /**
   * Generates a message and immediately commits every change.
   *
   * Staging happens before generation so the committed set matches exactly the
   * set the model was shown.
   *
   * @param cwd Directory inside the repository.
   * @param settings Settings snapshot.
   * @param signal Optional abort signal.
   * @returns The generated message and the git output.
   */
  public async generateAndCommit(
    cwd: string,
    settings: TabAISettings,
    signal?: AbortSignal,
  ): Promise<CommitRunResult> {
    const summary = await this.summarise(cwd, settings);
    const generated = await this.client.generateCommitMessage(settings, summary, signal);
    await this.git.stageAll(summary.repoRoot);
    const commitOutput = await this.git.commit(summary.repoRoot, generated.message);
    logger.info('committed on branch ' + summary.branch);
    return { generated, commitOutput };
  }
}
