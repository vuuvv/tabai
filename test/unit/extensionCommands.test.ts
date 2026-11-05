import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCacheCommand,
  showStatusCommand,
  toggleCompletionCommand,
  triggerCompletionCommand,
} from '../../src/commands/extensionCommands.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';
import type { TabAISettings } from '../../src/core/types.js';
import { mockState, resetMockState } from '../mocks/vscode.js';
import type { CompletionEngine } from '../../src/completion/engine.js';
import type { AIClient } from '../../src/ai/client.js';

/**
 * Builds a fake engine.
 *
 * @returns An engine stub with spies.
 */
function fakeEngine(): CompletionEngine {
  return {
    clearCache: vi.fn(),
    cacheSize: vi.fn().mockReturnValue(0),
  } as unknown as CompletionEngine;
}

/**
 * Builds a fake AI client.
 *
 * @param models Models the client reports.
 * @returns A client stub.
 */
function fakeClient(models: string[]): AIClient {
  return {
    listModels: vi.fn().mockResolvedValue(models),
  } as unknown as AIClient;
}

describe('triggerCompletionCommand', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('warns when no editor is active', async () => {
    await triggerCompletionCommand();
    expect(mockState.messages[0]?.kind).toBe('warning');
    expect(mockState.executedCommands).toHaveLength(0);
  });

  it('executes the inline suggest trigger command', async () => {
    mockState.activeTextEditor = {
      document: {
        uri: { toString: () => 'file:///a.ts', scheme: 'file', fsPath: '/a.ts' },
        languageId: 'typescript',
        version: 1,
        lineCount: 1,
        fileName: 'a.ts',
        getText: () => '',
      },
    };

    await triggerCompletionCommand();
    expect(mockState.executedCommands).toHaveLength(1);
    expect(mockState.executedCommands[0]?.command).toBe('editor.action.inlineSuggest.trigger');
  });
});

describe('toggleCompletionCommand', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('disables completion when it is enabled', async () => {
    const next = await toggleCompletionCommand(() => DEFAULT_SETTINGS);
    expect(next).toBe(false);
    expect(mockState.updatedConfiguration[0]).toMatchObject({
      key: 'tabai.completion.enabled',
      value: false,
    });
  });

  it('enables completion when it is disabled', async () => {
    const disabled: TabAISettings = { ...DEFAULT_SETTINGS, completionEnabled: false };
    const next = await toggleCompletionCommand(() => disabled);
    expect(next).toBe(true);
    expect(mockState.updatedConfiguration[0]?.value).toBe(true);
  });

  it('shows a confirmation message', async () => {
    await toggleCompletionCommand(() => DEFAULT_SETTINGS);
    expect(mockState.messages[0]?.message).toContain('inline completion disabled');
  });
});

describe('clearCacheCommand', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('clears the engine cache', async () => {
    const engine = fakeEngine();
    await clearCacheCommand(engine);
    expect(engine.clearCache).toHaveBeenCalledTimes(1);
  });

  it('shows a confirmation message', async () => {
    await clearCacheCommand(fakeEngine());
    expect(mockState.messages[0]?.message).toContain('cache cleared');
  });
});

describe('showStatusCommand', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('warns when the provider lists no models', async () => {
    await showStatusCommand(fakeClient([]), () => DEFAULT_SETTINGS);
    expect(mockState.messages[0]?.kind).toBe('warning');
    expect(mockState.messages[0]?.message).toContain('did not return a model list');
  });

  it('reports the configured models as available', async () => {
    await showStatusCommand(
      fakeClient(['qwen3.6-35b-a3b', 'other-model']),
      () => DEFAULT_SETTINGS,
    );
    const info = mockState.messages.find((entry) => entry.kind === 'info');
    expect(info?.message).toContain('Completion model: qwen3.6-35b-a3b ✓');
    expect(info?.message).toContain('Commit model: qwen3.6-35b-a3b ✓');
  });

  it('flags a model that is not listed', async () => {
    await showStatusCommand(fakeClient(['something-else']), () => DEFAULT_SETTINGS);
    const info = mockState.messages.find((entry) => entry.kind === 'info');
    expect(info?.message).toContain('(not listed)');
  });

  it('copies the report to the clipboard when asked', async () => {
    await showStatusCommand(fakeClient(['qwen3.6-35b-a3b']), () => DEFAULT_SETTINGS);
    expect(mockState.clipboard).toContain('Provider: http://192.168.2.101:1234/v1');
  });

  it('shows the configured protocol', async () => {
    await showStatusCommand(fakeClient(['qwen3.6-35b-a3b']), () => ({
      ...DEFAULT_SETTINGS,
      providerType: 'openai-compatible',
    }));
    const info = mockState.messages.find((entry) => entry.kind === 'info');
    expect(info?.message).toContain('Protocol: openai-compatible');
  });
});
