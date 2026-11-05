import { describe, expect, it, vi } from 'vitest';
import {
  CompletionEngine,
  CompletionReason,
  computeInsertionRange,
} from '../../src/completion/engine.js';
import type { CompletionResult, DocumentSnapshot, TabAISettings } from '../../src/core/types.js';
import { TabAIError } from '../../src/core/types.js';
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
 * @param text Document text.
 * @param overrides Fields to override.
 * @returns A snapshot.
 */
function docWith(
  text: string,
  overrides: Partial<DocumentSnapshot> = {},
): DocumentSnapshot {
  return {
    uri: 'file:///a.ts',
    languageId: 'typescript',
    version: 1,
    text,
    fileName: 'a.ts',
    ...overrides,
  };
}

/**
 * Builds a provider result.
 *
 * @param text Completion text.
 * @returns A provider result.
 */
function resultWith(text: string): CompletionResult {
  return { text, model: 'qwen', finishReason: 'stop', latencyMs: 5, fromCache: false };
}

/**
 * Creates a stub client that returns the given result.
 *
 * @param text Completion text to return.
 * @returns A client stub plus its call counter.
 */
function stubClient(text: string): {
  client: { complete: (...args: unknown[]) => Promise<CompletionResult> };
  calls: () => number;
} {
  let count = 0;
  return {
    client: {
      async complete(): Promise<CompletionResult> {
        count += 1;
        return resultWith(text);
      },
    },
    calls: () => count,
  };
}

describe('computeInsertionRange', () => {
  it('stays at the cursor when the completion adds new text', () => {
    const range = computeInsertionRange({ line: 2, character: 4 }, 'const a = 1;', ' = 2;');
    expect(range).toEqual({
      start: { line: 2, character: 4 },
      end: { line: 2, character: 4 },
    });
  });

  it('covers a tail the completion reproduces', () => {
    // tail is "a = 1;" and the completion starts with the same characters.
    const range = computeInsertionRange({ line: 0, character: 6 }, 'const a = 1;', 'a = 1;');
    expect(range.start.character).toBe(6);
    expect(range.end.character).toBe(12);
  });

  it('never ends before the cursor', () => {
    const range = computeInsertionRange({ line: 0, character: 20 }, 'short', 'x');
    expect(range.end.character).toBe(20);
  });

  it('handles an empty line', () => {
    const range = computeInsertionRange({ line: 0, character: 0 }, '', 'x');
    expect(range.end.character).toBe(0);
  });
});

describe('CompletionEngine.complete', () => {
  it('returns a processed completion on success', async () => {
    const stub = stubClient('return a;');
    const engine = new CompletionEngine({ client: stub.client });
    const outcome = await engine.complete(
      docWith('const a = 1;\n'),
      { line: 1, character: 0 },
      settingsWith(),
    );

    expect(outcome.reason).toBe(CompletionReason.Ok);
    expect(outcome.completion?.text).toBe('return a;');
    expect(outcome.fromCache).toBe(false);
  });

  it('bails out when completion is disabled', async () => {
    const stub = stubClient('return a;');
    const engine = new CompletionEngine({ client: stub.client });
    const outcome = await engine.complete(
      docWith('x'),
      { line: 0, character: 0 },
      settingsWith({ completionEnabled: false }),
    );

    expect(outcome.reason).toBe(CompletionReason.Disabled);
    expect(outcome.completion).toBeNull();
    expect(stub.calls()).toBe(0);
  });

  it('bails out when the token is already cancelled', async () => {
    const stub = stubClient('return a;');
    const engine = new CompletionEngine({ client: stub.client });
    const source = new CancellationSource();
    source.cancel();
    const outcome = await engine.complete(
      docWith('x'),
      { line: 0, character: 0 },
      settingsWith(),
      source,
    );

    expect(outcome.reason).toBe(CompletionReason.Cancelled);
    expect(stub.calls()).toBe(0);
  });

  it('cancels during the first debounce phase', async () => {
    const stub = stubClient('return a;');
    const source = new CancellationSource();
    const engine = new CompletionEngine({
      client: stub.client,
      sleep: async (_ms, signal) => {
        source.cancel();
        void signal;
      },
    });

    const outcome = await engine.complete(
      docWith('x'),
      { line: 0, character: 0 },
      settingsWith({ contextDebounceMs: 25 }),
      source,
    );

    expect(outcome.reason).toBe(CompletionReason.Cancelled);
    expect(stub.calls()).toBe(0);
  });

  it('skips a middle-of-line position when multiline is off', async () => {
    const stub = stubClient('x');
    const engine = new CompletionEngine({ client: stub.client });
    const outcome = await engine.complete(
      docWith('const a = 1;'),
      { line: 0, character: 6 },
      settingsWith({ multiline: false }),
    );

    expect(outcome.reason).toBe(CompletionReason.Skipped);
    expect(stub.calls()).toBe(0);
  });

  it('allows a middle-of-line position when multiline is on', async () => {
    const stub = stubClient('x = 2');
    const engine = new CompletionEngine({ client: stub.client });
    const outcome = await engine.complete(
      docWith('const a = 1;'),
      { line: 0, character: 9 },
      settingsWith({ multiline: true }),
    );

    expect(outcome.completion?.text).toBe('x = 2');
  });

  it('serves a repeated request from the cache', async () => {
    const stub = stubClient('return a;');
    const engine = new CompletionEngine({ client: stub.client });
    const doc = docWith('const a = 1;\n');
    const position = { line: 1, character: 0 };

    const first = await engine.complete(doc, position, settingsWith());
    const second = await engine.complete(doc, position, settingsWith());

    expect(first.reason).toBe(CompletionReason.Ok);
    expect(second.reason).toBe(CompletionReason.Cached);
    expect(second.fromCache).toBe(true);
    expect(stub.calls()).toBe(1);
  });

  it('does not cache when the cache size is zero', async () => {
    const stub = stubClient('return a;');
    const engine = new CompletionEngine({ client: stub.client });
    const doc = docWith('const a = 1;\n');
    const position = { line: 1, character: 0 };

    await engine.complete(doc, position, settingsWith({ cacheSize: 0 }));
    await engine.complete(doc, position, settingsWith({ cacheSize: 0 }));

    expect(stub.calls()).toBe(2);
  });

  it('invalidates a cached result that no longer post-processes cleanly', async () => {
    const stub = stubClient('return a;');
    const engine = new CompletionEngine({ client: stub.client });
    const doc = docWith('const a = 1;\n');
    const position = { line: 1, character: 0 };

    await engine.complete(doc, position, settingsWith());
    // Same position but a prefix that already ends with the cached answer
    // makes the cached value reduce to nothing, forcing a re-request.
    const second = await engine.complete(
      docWith('const a = 1;\nreturn a;'),
      position,
      settingsWith(),
    );

    expect(second.fromCache).toBe(false);
    expect(stub.calls()).toBe(2);
  });

  it('clears the cache on demand', async () => {
    const stub = stubClient('return a;');
    const engine = new CompletionEngine({ client: stub.client });
    const doc = docWith('const a = 1;\n');
    const position = { line: 1, character: 0 };

    await engine.complete(doc, position, settingsWith());
    expect(engine.cacheSize()).toBe(1);
    engine.clearCache();
    expect(engine.cacheSize()).toBe(0);
  });

  it('reports a rejected completion', async () => {
    const stub = stubClient('   ');
    const engine = new CompletionEngine({ client: stub.client });
    const outcome = await engine.complete(
      docWith('x'),
      { line: 0, character: 1 },
      settingsWith(),
    );

    expect(outcome.reason).toBe(CompletionReason.Rejected);
    expect(outcome.completion).toBeNull();
  });

  it('reports an aborted provider error as cancelled', async () => {
    const engine = new CompletionEngine({
      client: {
        async complete(): Promise<CompletionResult> {
          throw new TabAIError('aborted', 'cancelled');
        },
      },
    });
    const outcome = await engine.complete(
      docWith('x'),
      { line: 0, character: 1 },
      settingsWith(),
    );

    expect(outcome.reason).toBe(CompletionReason.Cancelled);
  });

  it('reports a network error with its kind', async () => {
    const engine = new CompletionEngine({
      client: {
        async complete(): Promise<CompletionResult> {
          throw new TabAIError('network', 'down');
        },
      },
    });
    const outcome = await engine.complete(
      docWith('x'),
      { line: 0, character: 1 },
      settingsWith(),
    );

    expect(outcome.reason).toBe('error:network');
  });

  it('reports a non-TabAI error generically', async () => {
    const engine = new CompletionEngine({
      client: {
        async complete(): Promise<CompletionResult> {
          throw new Error('unexpected');
        },
      },
    });
    const outcome = await engine.complete(
      docWith('x'),
      { line: 0, character: 1 },
      settingsWith(),
    );

    expect(outcome.reason).toBe(CompletionReason.Error);
  });

  it('waits the full debounce budget across both phases', async () => {
    const stub = stubClient('return a;');
    const sleeps: number[] = [];
    let clock = 0;
    const engine = new CompletionEngine({
      client: stub.client,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    await engine.complete(
      docWith('const a = 1;\n'),
      { line: 1, character: 0 },
      settingsWith({ contextDebounceMs: 25, debounceMs: 75 }),
    );

    expect(sleeps[0]).toBe(25);
    expect(sleeps[1]).toBe(50);
    expect(sleeps.reduce((sum, value) => sum + value, 0)).toBe(75);
  });

  it('does not sleep a second time when the budget is already spent', async () => {
    const stub = stubClient('return a;');
    const sleeps: number[] = [];
    const engine = new CompletionEngine({
      client: stub.client,
      now: () => 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await engine.complete(
      docWith('const a = 1;\n'),
      { line: 1, character: 0 },
      settingsWith({ contextDebounceMs: 0, debounceMs: 0 }),
    );

    // Only the first (zero-length) debounce phase runs; the top-up phase is
    // skipped entirely because the budget is already exhausted.
    expect(sleeps).toEqual([0]);
  });

  it('marks multiline completions', async () => {
    const stub = stubClient('const b = 2;\nreturn b;');
    const engine = new CompletionEngine({ client: stub.client });
    const outcome = await engine.complete(
      docWith('const a = 1;\n'),
      { line: 1, character: 0 },
      settingsWith(),
    );

    expect(outcome.completion?.multiline).toBe(true);
  });

  it('keeps the raw provider result for telemetry', async () => {
    const stub = stubClient('return a;');
    const engine = new CompletionEngine({ client: stub.client });
    const outcome = await engine.complete(
      docWith('const a = 1;\n'),
      { line: 1, character: 0 },
      settingsWith(),
    );

    expect(outcome.completion?.raw.model).toBe('qwen');
    expect(outcome.completion?.raw.finishReason).toBe('stop');
  });

  it('reports a duration', async () => {
    const stub = stubClient('return a;');
    let clock = 0;
    const engine = new CompletionEngine({
      client: stub.client,
      now: () => {
        clock += 10;
        return clock;
      },
    });
    const outcome = await engine.complete(
      docWith('const a = 1;\n'),
      { line: 1, character: 0 },
      settingsWith(),
    );

    expect(outcome.durationMs).toBeGreaterThan(0);
  });

  it('accepts an injected cache', async () => {
    const stub = stubClient('return a;');
    const external = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      delete: vi.fn().mockReturnValue(false),
      clear: vi.fn(),
      size: 0,
      liveSize: () => 0,
    };
    const engine = new CompletionEngine({ client: stub.client, cache: external });
    await engine.complete(docWith('const a = 1;\n'), { line: 1, character: 0 }, settingsWith());

    expect(external.set).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the cache when the size setting changes', async () => {
    const stub = stubClient('return a;');
    const engine = new CompletionEngine({ client: stub.client });
    const doc = docWith('const a = 1;\n');
    const position = { line: 1, character: 0 };

    await engine.complete(doc, position, settingsWith({ cacheSize: 10 }));
    expect(engine.cacheSize()).toBe(1);

    await engine.complete(doc, position, settingsWith({ cacheSize: 5 }));
    // Rebuilt cache starts empty, then the new result is stored.
    expect(engine.cacheSize()).toBe(1);
  });

  it('passes the abort signal to the provider', async () => {
    let received: AbortSignal | undefined;
    const engine = new CompletionEngine({
      client: {
        async complete(_settings: unknown, _context: unknown, signal?: AbortSignal) {
          received = signal;
          return resultWith('x');
        },
      },
    });

    await engine.complete(docWith('a'), { line: 0, character: 1 }, settingsWith());
    expect(received).toBeDefined();
    expect(received?.aborted).toBe(false);
  });
});
