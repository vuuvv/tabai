/**
 * Extension entry point.
 *
 * Wires settings, the AI client, the completion engine and the commands
 * together, and registers everything with the extension context so a
 * deactivation cleans up completely.
 */

import * as vscode from 'vscode';
import type { TabAISettings } from './core/types.js';
import { logger, setLogLevel, setLogSink } from './core/logger.js';
import type { ConfigGetter } from './config/settings.js';
import { readSettings } from './config/settings.js';
import { AIClient } from './ai/client.js';
import { CompletionEngine } from './completion/engine.js';
import { registerCompletionProvider } from './completion/vscodeProvider.js';
import { GitService } from './git/gitService.js';
import { CommitService } from './git/commitService.js';
import {
  generateCommitMessageAndCommitCommand,
  generateCommitMessageCommand,
} from './git/gitCommands.js';
import {
  clearCacheCommand,
  showStatusCommand,
  toggleCompletionCommand,
  triggerCompletionCommand,
} from './commands/extensionCommands.js';

/** The output channel used for all extension logging. */
let outputChannel: vscode.OutputChannel | undefined;

/**
 * Creates a settings getter bound to the workspace configuration.
 *
 * Reading a snapshot per request means a settings change takes effect on the
 * next completion rather than needing a restart.
 *
 * @returns A function producing a fresh settings snapshot.
 */
function createSettingsGetter(): () => TabAISettings {
  return () => {
    const configuration = vscode.workspace.getConfiguration();
    const getter: ConfigGetter = <T>(key: string, defaultValue: T): T =>
      configuration.get<T>(key, defaultValue);
    return readSettings(getter);
  };
}

/**
 * Activates the extension.
 *
 * @param context The extension context.
 */
export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('TabAI');
  context.subscriptions.push(outputChannel);
  setLogSink((level, message) => {
    outputChannel?.appendLine(message);
    if (level === 'error') {
      console.error(message);
    }
  });

  const getSettings = createSettingsGetter();
  setLogLevel(getSettings().logLevel);
  logger.info(
    'TabAI activating (logLevel=' + getSettings().logLevel + ')',
  );

  const client = new AIClient();
  const engine = new CompletionEngine({ client });
  const gitService = new GitService();
  const commitService = new CommitService(gitService, client);

  registerCompletionProvider(context, engine, getSettings);

  /**
   * Registers one command with error containment.
   *
   * @param id The command id.
   * @param handler The handler implementation.
   */
  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(id + ' failed: ' + message);
          void vscode.window.showErrorMessage('TabAI: ' + message);
          return undefined;
        }
      }),
    );
  };

  register('tabai.triggerCompletion', () => triggerCompletionCommand());
  register('tabai.toggleCompletion', () => toggleCompletionCommand(getSettings));
  register('tabai.clearCache', () => clearCacheCommand(engine));
  register('tabai.showStatus', () => showStatusCommand(client, getSettings));
  register('tabai.generateCommitMessage', () =>
    generateCommitMessageCommand(commitService, getSettings),
  );
  register('tabai.generateCommitMessageAndCommit', () =>
    generateCommitMessageAndCommitCommand(commitService, getSettings),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('tabai.logLevel')) {
        const next = getSettings().logLevel;
        setLogLevel(next);
        // Confirmed at info level so the user sees the change took effect even
        // when switching *to* a quieter level.
        logger.info('log level changed to "' + next + '"');
        return;
      }
      if (event.affectsConfiguration('tabai')) {
        logger.info('settings changed, next request uses the new values');
      }
    }),
  );

  logger.info('TabAI activated');
}

/**
 * Deactivates the extension.
 *
 * Everything registered through `context.subscriptions` is disposed by VS
 * Code; this only releases the output channel reference.
 */
export function deactivate(): void {
  logger.info('TabAI deactivated');
  outputChannel = undefined;
}
