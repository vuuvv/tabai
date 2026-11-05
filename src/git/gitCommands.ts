/**
 * VS Code command handlers for commit message generation.
 *
 * These wrap {@link CommitService} with the editor-facing concerns: picking a
 * repository root, showing progress, writing to the SCM input box, and asking
 * for confirmation before committing.
 */

import * as vscode from 'vscode';
import type { TabAISettings } from '../core/types.js';
import { TabAIError } from '../core/types.js';
import { logger } from '../core/logger.js';
import type { CommitService } from './commitService.js';

/**
 * Resolves the directory used for git commands.
 *
 * Prefers the folder of the active editor so a multi-root workspace commits
 * the project the user is looking at.
 *
 * @returns An absolute directory path, or `null` when no folder is open.
 */
export function resolveWorkspaceCwd(): string | null {
  const active = vscode.window.activeTextEditor;
  if (active !== undefined && active.document.uri.scheme === 'file') {
    const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (folder !== undefined) {
      return folder.uri.fsPath;
    }
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders !== undefined && folders.length > 0) {
    const first = folders[0];
    return first === undefined ? null : first.uri.fsPath;
  }
  return null;
}

/**
 * Returns the SCM input box used to display the generated message.
 *
 * @returns The git SCM input box, or `undefined` when the git extension is off.
 */
export function getScmInputBox(
  cwd?: string,
): vscode.SourceControlInputBox | undefined {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (gitExtension === undefined) {
    return undefined;
  }
  const exports = gitExtension.exports as
    | {
        getAPI?: (version: number) => {
          repositories: {
            rootUri: { fsPath: string };
            inputBox: vscode.SourceControlInputBox;
          }[];
        };
      }
    | undefined;
  const api = exports?.getAPI?.(1);
  const repositories = api?.repositories;
  if (repositories === undefined || repositories.length === 0) {
    return undefined;
  }

  // In a multi-root workspace each folder is its own repository; writing to
  // the first one would put the message in the wrong input box.
  if (cwd !== undefined) {
    const match = repositories.find(
      (repository) =>
        cwd === repository.rootUri.fsPath ||
        cwd.startsWith(repository.rootUri.fsPath + '/'),
    );
    if (match !== undefined) {
      return match.inputBox;
    }
  }
  return repositories[0]?.inputBox;
}

/**
 * Maps a thrown error to a user-facing message.
 *
 * @param error The thrown value.
 * @returns A message suitable for `showErrorMessage`.
 */
export function describeError(error: unknown): string {
  if (error instanceof TabAIError) {
    switch (error.kind) {
      case 'network':
        return 'Cannot reach the AI provider. Check tabai.provider.baseUrl.';
      case 'timeout':
        return 'The AI provider took too long to respond.';
      case 'http':
        return 'The AI provider rejected the request: ' + error.message;
      case 'parse':
        return 'The AI provider returned an unusable response.';
      case 'aborted':
        return 'Request cancelled.';
      case 'not-configured':
        return error.message;
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Generates a commit message and places it in the SCM input box.
 *
 * @param service The commit service.
 * @param getSettings Returns the current settings snapshot.
 */
export async function generateCommitMessageCommand(
  service: CommitService,
  getSettings: () => TabAISettings,
): Promise<void> {
  const cwd = resolveWorkspaceCwd();
  if (cwd === null) {
    void vscode.window.showWarningMessage('TabAI: open a folder before generating a commit message.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: 'TabAI: generating commit message',
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        const settings = getSettings();
        const { generated } = await service.generate(cwd, settings, controller.signal);
        const inputBox = getScmInputBox(cwd);
        if (inputBox !== undefined) {
          inputBox.value = generated.message;
        }
        logger.info(
          'commit message generated in ' + generated.latencyMs + 'ms using ' + generated.model,
        );
        void vscode.window.showInformationMessage(
          'TabAI: commit message generated (' + generated.latencyMs + 'ms).',
        );
      } catch (error) {
        logger.error('commit message generation failed: ' + describeError(error));
        void vscode.window.showErrorMessage('TabAI: ' + describeError(error));
      }
    },
  );
}

/**
 * Generates a commit message and commits immediately, after confirmation
 * unless `tabai.git.autoCommit` is enabled.
 *
 * @param service The commit service.
 * @param getSettings Returns the current settings snapshot.
 */
export async function generateCommitMessageAndCommitCommand(
  service: CommitService,
  getSettings: () => TabAISettings,
): Promise<void> {
  const cwd = resolveWorkspaceCwd();
  if (cwd === null) {
    void vscode.window.showWarningMessage('TabAI: open a folder before committing.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: 'TabAI: generating commit message',
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        const settings = getSettings();
        const preview = await service.generate(cwd, settings, controller.signal);

        if (!settings.gitAutoCommit) {
          const choice = await vscode.window.showInformationMessage(
            'Commit with: ' + preview.generated.subject,
            { modal: true },
            'Commit',
            'Cancel',
          );
          if (choice !== 'Commit') {
            const inputBox = getScmInputBox(cwd);
            if (inputBox !== undefined) {
              inputBox.value = preview.generated.message;
            }
            return;
          }
        }

        const result = await service.generateAndCommit(cwd, settings, controller.signal);
        void vscode.window.showInformationMessage(
          'TabAI: committed — ' + result.generated.subject,
        );
      } catch (error) {
        logger.error('commit failed: ' + describeError(error));
        void vscode.window.showErrorMessage('TabAI: ' + describeError(error));
      }
    },
  );
}
