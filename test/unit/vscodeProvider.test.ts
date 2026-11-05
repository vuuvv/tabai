import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  isSupportedDocument,
  registerCompletionProvider,
  snapshotDocument,
} from '../../src/completion/vscodeProvider.js';
import type { CompletionEngine } from '../../src/completion/engine.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';
import { mockState, resetMockState } from '../mocks/vscode.js';
import type { TextDocumentLike } from '../mocks/vscode.js';

/**
 * Builds an engine stub with the full surface the provider adapter uses.
 *
 * @param complete The completion implementation, usually a `vi.fn()`.
 * @returns A cast-compatible engine.
 */
function fakeEngine(complete: unknown): CompletionEngine {
  return {
    complete,
    setNeighborProvider: vi.fn(),
  } as unknown as CompletionEngine;
}

/**
 * Builds a fake VS Code document.
 *
 * @param overrides Fields to override.
 * @returns A document-like object.
 */
function fakeDocument(overrides: Partial<TextDocumentLike> = {}): TextDocumentLike {
  const text = overrides.getText?.() ?? 'const a = 1;\n';
  return {
    uri: {
      toString: () => 'file:///a.ts',
      scheme: 'file',
      fsPath: '/a.ts',
    },
    languageId: 'typescript',
    version: 1,
    lineCount: text.split('\n').length,
    fileName: 'a.ts',
    getText: () => text,
    ...overrides,
  };
}

/**
 * Creates a context stub that records disposables.
 *
 * @returns A minimal extension context.
 */
function fakeContext(): { subscriptions: { dispose(): void }[] } {
  return { subscriptions: [] };
}

describe('isSupportedDocument', () => {
  it('accepts a normal source file', () => {
    expect(isSupportedDocument(fakeDocument() as never)).toBe(true);
  });

  it('rejects the output scheme', () => {
    const doc = fakeDocument({
      uri: { toString: () => 'output://1', scheme: 'output', fsPath: '' },
    });
    expect(isSupportedDocument(doc as never)).toBe(false);
  });

  it('rejects a log language', () => {
    expect(isSupportedDocument(fakeDocument({ languageId: 'log' }) as never)).toBe(false);
  });

  it('rejects plaintext', () => {
    expect(isSupportedDocument(fakeDocument({ languageId: 'plaintext' }) as never)).toBe(false);
  });

  it('rejects git-commit buffers', () => {
    expect(isSupportedDocument(fakeDocument({ languageId: 'git-commit' }) as never)).toBe(false);
  });

  it('rejects an empty document', () => {
    expect(isSupportedDocument(fakeDocument({ lineCount: 0 }) as never)).toBe(false);
  });

  it('accepts search-result-like ids that merely contain "log"', () => {
    // "catalog" contains "log" but is not a log buffer; the pattern is anchored
    // on word boundaries so this must still be supported.
    expect(isSupportedDocument(fakeDocument({ languageId: 'catalog' }) as never)).toBe(true);
  });
});

describe('snapshotDocument', () => {
  it('captures the document state', () => {
    const snapshot = snapshotDocument(fakeDocument() as never);
    expect(snapshot.uri).toBe('file:///a.ts');
    expect(snapshot.languageId).toBe('typescript');
    expect(snapshot.version).toBe(1);
    expect(snapshot.text).toBe('const a = 1;\n');
    expect(snapshot.fileName).toBe('a.ts');
  });
});

describe('registerCompletionProvider', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('registers an inline completion provider', () => {
    const engine = fakeEngine(vi.fn());
    const context = fakeContext();
    registerCompletionProvider(context as never, engine, () => DEFAULT_SETTINGS);

    expect(mockState.inlineProvider).toBeDefined();
    expect(context.subscriptions).toHaveLength(1);
  });

  it('returns undefined for an unsupported document', async () => {
    const engine = fakeEngine(vi.fn());
    registerCompletionProvider(fakeContext() as never, engine, () => DEFAULT_SETTINGS);

    const result = await mockState.inlineProvider?.provideInlineCompletionItems(
      fakeDocument({ languageId: 'plaintext' }) as never,
      new vscode.Position(0, 0),
      { triggerKind: vscode.InlineCompletionTriggerKind.Automatic },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    );

    expect(result).toBeUndefined();
    expect(engine.complete).not.toHaveBeenCalled();
  });

  it('returns undefined when completion is disabled', async () => {
    const engine = fakeEngine(vi.fn());
    registerCompletionProvider(fakeContext() as never, engine, () => ({
      ...DEFAULT_SETTINGS,
      completionEnabled: false,
    }));

    const result = await mockState.inlineProvider?.provideInlineCompletionItems(
      fakeDocument() as never,
      new vscode.Position(0, 0),
      { triggerKind: vscode.InlineCompletionTriggerKind.Automatic },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    );

    expect(result).toBeUndefined();
    expect(engine.complete).not.toHaveBeenCalled();
  });

  it('converts an engine completion into an inline completion item', async () => {
    const engine = fakeEngine(
      vi.fn().mockResolvedValue({
        completion: {
          text: 'return a;',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
          multiline: false,
          raw: { text: 'return a;', model: 'qwen', finishReason: 'stop', latencyMs: 1, fromCache: false },
        },
        reason: 'ok',
        durationMs: 5,
        fromCache: false,
      }),
    );

    registerCompletionProvider(fakeContext() as never, engine, () => DEFAULT_SETTINGS);

    const items = await mockState.inlineProvider?.provideInlineCompletionItems(
      fakeDocument() as never,
      new vscode.Position(1, 0),
      { triggerKind: vscode.InlineCompletionTriggerKind.Automatic },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    );

    expect(items).toHaveLength(1);
    expect(items?.[0]?.insertText).toBe('return a;');
    expect(items?.[0]?.range.start.line).toBe(1);
  });

  it('returns undefined when the engine produces nothing', async () => {
    const engine = fakeEngine(
      vi.fn().mockResolvedValue({
        completion: null,
        reason: 'rejected',
        durationMs: 5,
        fromCache: false,
      }),
    );

    registerCompletionProvider(fakeContext() as never, engine, () => DEFAULT_SETTINGS);

    const result = await mockState.inlineProvider?.provideInlineCompletionItems(
      fakeDocument() as never,
      new vscode.Position(0, 0),
      { triggerKind: vscode.InlineCompletionTriggerKind.Automatic },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    );

    expect(result).toBeUndefined();
  });

  it('forwards the cancellation token to the engine', async () => {
    const complete = vi.fn().mockResolvedValue({
      completion: null,
      reason: 'cancelled',
      durationMs: 0,
      fromCache: false,
    });
    registerCompletionProvider(
      fakeContext() as never,
      fakeEngine(complete),
      () => DEFAULT_SETTINGS,
    );

    await mockState.inlineProvider?.provideInlineCompletionItems(
      fakeDocument() as never,
      new vscode.Position(0, 0),
      { triggerKind: vscode.InlineCompletionTriggerKind.Automatic },
      { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) },
    );

    const passedToken = complete.mock.calls[0]?.[3] as { isCancellationRequested: boolean };
    expect(passedToken.isCancellationRequested).toBe(true);
  });
});
