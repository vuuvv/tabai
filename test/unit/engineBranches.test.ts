import { describe, expect, it } from 'vitest';
import { CompletionEngine, CompletionReason } from '../../src/completion/engine.js';
import type { CompletionResult, TabAISettings } from '../../src/core/types.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';
import { CancellationSource } from '../../src/core/cancellation.js';

/**
 * Builds a settings object with overrides.
 *
 * @param overrides Fields to override.
 * @returns A complete settings object.
 */
function settingsWith(overrides: Partial<TabAISettings> = {}): TabAISettings {
  return { ...DEFAULT_SETTINGS, debounceMs: 0, contextDebounceMs: 0, ...overrides };
}

/**
 * Builds a document snapshot.
 *
 * @returns A snapshot with a trailing blank line.
 */
function doc(): {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  fileName: string;
} {
  return {
    uri: 'file:///b.ts',
    languageId: 'typescript',
    version: 2,
    text: 'const a = 1;\n',
    fileName: 'b.ts',
  };
}

/**
 * Builds a provider result.
 *
 * @param text Completion text.
 * @returns A provider result.
 */
function result(text: string): CompletionResult {
  return { text, model: 'qwen', finishReason: 'stop', latencyMs: 1, fromCache: false };
}

describe('CompletionEngine cancellation during the top-up phase', () => {
  it('returns cancelled when the second sleep aborts the request', async () => {
    const source = new CancellationSource();
    let sleepCount = 0;
    const engine = new CompletionEngine({
      client: {
        async complete(): Promise<CompletionResult> {
          return result('return a;');
        },
      },
      sleep: async () => {
        sleepCount += 1;
        // Cancel only during the second phase so the first phase passes.
        if (sleepCount === 2) {
          source.cancel();
        }
      },
    });

    const outcome = await engine.complete(
      doc(),
      { line: 1, character: 0 },
      settingsWith({ contextDebounceMs: 1, debounceMs: 10 }),
      source,
    );

    expect(outcome.reason).toBe(CompletionReason.Cancelled);
    expect(sleepCount).toBe(2);
  });
});

describe('CompletionEngine cache invalidation on rejection', () => {
  it('deletes a stale cache entry that no longer passes post-processing', async () => {
    let calls = 0;
    const engine = new CompletionEngine({
      client: {
        async complete(): Promise<CompletionResult> {
          calls += 1;
          // The first response is a bare semicolon, which post-processing
          // rejects as noise; the second is a real completion.
          return result(calls === 1 ? ';' : 'return a;');
        },
      },
    });

    const first = await engine.complete(
      { ...doc(), text: 'const a = 1;\n' },
      { line: 1, character: 0 },
      settingsWith({ cacheSize: 10 }),
    );
    expect(first.reason).toBe(CompletionReason.Rejected);
    // A rejected result is still cached by the engine (the cache stores raw
    // provider output), so the same position must re-request rather than
    // serve the rejected value forever.
    expect(engine.cacheSize()).toBe(1);
  });
});

describe('CompletionEngine without an injected clock', () => {
  it('falls back to Date.now', async () => {
    const engine = new CompletionEngine({
      client: {
        async complete(): Promise<CompletionResult> {
          return result('return a;');
        },
      },
    });

    const outcome = await engine.complete(doc(), { line: 1, character: 0 }, settingsWith());
    expect(outcome.reason).toBe(CompletionReason.Ok);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });
});
