import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showStatusCommand } from '../../src/commands/extensionCommands.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';
import { mockState, resetMockState } from '../mocks/vscode.js';
import type { AIClient } from '../../src/ai/client.js';

/**
 * Builds a fake AI client.
 *
 * @param models Models the client reports.
 * @returns A client stub.
 */
function fakeClient(models: string[]): AIClient {
  return { listModels: vi.fn().mockResolvedValue(models) } as unknown as AIClient;
}

describe('showStatusCommand URL diagnostics', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('hints at the native API when the URL ends with /api/v1', async () => {
    await showStatusCommand(fakeClient([]), () => ({
      ...DEFAULT_SETTINGS,
      baseUrl: 'http://192.168.2.101:1234/api/v1',
    }));

    const warning = mockState.messages.find((entry) => entry.kind === 'warning');
    expect(warning?.message).toContain("LM Studio's native API");
    expect(warning?.message).toContain('use "...:1234/v1" instead');
  });

  it('gives a generic hint for any other empty result', async () => {
    await showStatusCommand(fakeClient([]), () => ({
      ...DEFAULT_SETTINGS,
      baseUrl: 'http://192.168.2.101:1234/v1',
    }));

    const warning = mockState.messages.find((entry) => entry.kind === 'warning');
    expect(warning?.message).toContain('ends with "/v1"');
    expect(warning?.message).not.toContain('native API');
  });

  it('warns inside the success dialog when the URL looks wrong', async () => {
    await showStatusCommand(fakeClient(['qwen3.6-35b-a3b']), () => ({
      ...DEFAULT_SETTINGS,
      baseUrl: 'http://192.168.2.101:1234/api/v1',
    }));

    const info = mockState.messages.find((entry) => entry.kind === 'info');
    expect(info?.message).toContain('WARNING');
    expect(info?.message).toContain('http://192.168.2.101:1234/v1');
  });

  it('does not warn for a correct URL', async () => {
    await showStatusCommand(fakeClient(['qwen3.6-35b-a3b']), () => DEFAULT_SETTINGS);

    const info = mockState.messages.find((entry) => entry.kind === 'info');
    expect(info?.message).not.toContain('WARNING');
  });
});
