/**
 * Miscellaneous user-facing commands.
 *
 * These are the small conveniences around completion: triggering manually,
 * toggling the feature, clearing the cache and reporting provider status.
 */

import * as vscode from 'vscode';
import type { TabAISettings } from '../core/types.js';
import { logger } from '../core/logger.js';
import type { CompletionEngine } from '../completion/engine.js';
import type { AIClient } from '../ai/client.js';

/** The settings key toggled by the toggle command. */
const ENABLED_KEY = 'tabai.completion.enabled';

/**
 * Triggers an inline suggestion in the active editor.
 *
 * VS Code has no public API to force a suggestion, so the command asks the
 * editor to run its own trigger command, which routes back into our provider.
 */
export async function triggerCompletionCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showWarningMessage('TabAI: open an editor to trigger a completion.');
    return;
  }
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
}

/**
 * Toggles completion on or off and persists the choice.
 *
 * @param getSettings Returns the current settings snapshot.
 * @returns The new enabled state.
 */
export async function toggleCompletionCommand(
  getSettings: () => TabAISettings,
): Promise<boolean> {
  const configuration = vscode.workspace.getConfiguration();
  const current = getSettings().completionEnabled;
  const next = !current;
  await configuration.update(ENABLED_KEY, next, vscode.ConfigurationTarget.Global);
  logger.info('completion ' + (next ? 'enabled' : 'disabled'));
  void vscode.window.showInformationMessage(
    'TabAI: inline completion ' + (next ? 'enabled' : 'disabled') + '.',
  );
  return next;
}

/**
 * Clears the completion result cache.
 *
 * @param engine The completion engine whose cache is cleared.
 */
export async function clearCacheCommand(engine: CompletionEngine): Promise<void> {
  engine.clearCache();
  void vscode.window.showInformationMessage('TabAI: completion cache cleared.');
}

/**
 * Reports provider reachability and the available models.
 *
 * @param client The AI client.
 * @param getSettings Returns the current settings snapshot.
 */
export async function showStatusCommand(
  client: AIClient,
  getSettings: () => TabAISettings,
): Promise<void> {
  const settings = getSettings();
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'TabAI: checking provider',
      cancellable: false,
    },
    async () => {
      const models = await client.listModels(settings);
      if (models.length === 0) {
        const hint = settings.baseUrl.includes('/api/v1')
          ? ' The URL ends with "/api/v1", which is LM Studio\'s native API. ' +
            'Inline completion needs the OpenAI-compatible endpoint: use "...:1234/v1" instead.'
          : ' Check that the server is running and that the URL ends with "/v1".';
        void vscode.window.showWarningMessage(
          'TabAI: provider at ' + settings.baseUrl + ' did not return a model list.' + hint,
        );
        return;
      }
      const hasCompletionModel = models.includes(settings.completionModel);
      const hasCommitModel = models.includes(settings.commitModel);
      const lines = [
        'Provider: ' + settings.baseUrl,
        'Protocol: ' + settings.providerType,
        ...(settings.baseUrl.includes('/api/v1')
          ? [
              'WARNING: "/api/v1" is LM Studio\'s native API. Completion will fail;',
              '         set tabai.provider.baseUrl to "' +
                settings.baseUrl.replace(/\/api\/v1\/?$/, '/v1') +
                '".',
            ]
          : []),
        'Completion model: ' + settings.completionModel + (hasCompletionModel ? ' ✓' : ' (not listed)'),
        'Commit model: ' + settings.commitModel + (hasCommitModel ? ' ✓' : ' (not listed)'),
        'Models: ' + models.join(', '),
      ];
      const choice = await vscode.window.showInformationMessage(
        lines.join('\n'),
        { modal: true },
        'Copy to clipboard',
      );
      if (choice === 'Copy to clipboard') {
        await vscode.env.clipboard.writeText(lines.join('\n'));
      }
    },
  );
}
