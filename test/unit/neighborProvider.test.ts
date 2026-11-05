import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  gatherNeighborContext,
  isSourceFile,
  registerCompletionProvider,
} from '../../src/completion/vscodeProvider.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';
import type { CompletionEngine } from '../../src/completion/engine.js';
import { mockState, resetMockState } from '../mocks/vscode.js';
import type { TextDocumentLike } from '../mocks/vscode.js';

/**
 * Builds a document-like object.
 *
 * @param overrides Fields to override.
 * @returns A document fixture.
 */
function doc(overrides: Partial<TextDocumentLike> = {}): TextDocumentLike {
  const text = overrides.getText?.() ?? 'export function calculateTotal(items) {\n';
  return {
    uri: { toString: () => 'file:///repo/src/current.ts', scheme: 'file', fsPath: '/repo/src/current.ts' },
    languageId: 'typescript',
    version: 1,
    lineCount: text.split('\n').length,
    fileName: 'current.ts',
    getText: () => text,
    ...overrides,
  };
}

/**
 * Creates a URI-like object for a workspace file.
 *
 * @param fsPath Absolute path.
 * @returns A URI fixture.
 */
function uriOf(fsPath: string): { toString(): string; fsPath: string; scheme: string } {
  return { toString: () => 'file://' + fsPath, fsPath, scheme: 'file' };
}

/**
 * Builds an engine stub.
 *
 * @returns The stub plus its neighbour-provider spy.
 */
function engineStub(): {
  engine: CompletionEngine;
  setNeighborProvider: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
} {
  const setNeighborProvider = vi.fn();
  const complete = vi.fn().mockResolvedValue({ completion: null, reason: 'rejected', durationMs: 0, fromCache: false });
  return {
    engine: { complete, setNeighborProvider } as unknown as CompletionEngine,
    setNeighborProvider,
    complete,
  };
}

describe('isSourceFile', () => {
  it('accepts common source extensions', () => {
    for (const path of ['a.ts', 'b.tsx', 'c.py', 'd.go', 'e.rs', 'f.cpp', 'g.java']) {
      expect(isSourceFile(path)).toBe(true);
    }
  });

  it('rejects non-source extensions', () => {
    expect(isSourceFile('package.json')).toBe(false);
    expect(isSourceFile('README.md')).toBe(false);
    expect(isSourceFile('image.png')).toBe(false);
  });

  it('rejects paths without an extension', () => {
    expect(isSourceFile('Makefile')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isSourceFile('A.TS')).toBe(true);
  });
});

describe('gatherNeighborContext', () => {
  beforeEach(() => {
    resetMockState();
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
  });

  it('finds a similar snippet in another file', async () => {
    mockState.workspaceFiles = [uriOf('/repo/src/helper.ts')];
    mockState.fileContents['/repo/src/helper.ts'] =
      'export function calculateTotal(items) {\n  return items.reduce(sum, 0);\n}\n';

    const snippets = await gatherNeighborContext(doc() as never, new vscode.Position(0, 30));
    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.path).toBe('src/helper.ts');
  });

  it('prefers the open buffer over disk for unsaved edits', async () => {
    mockState.workspaceFiles = [uriOf('/repo/src/helper.ts')];
    mockState.fileContents['/repo/src/helper.ts'] = 'unrelated content';
    mockState.openDocuments = [
      {
        uri: uriOf('/repo/src/helper.ts'),
        languageId: 'typescript',
        version: 2,
        lineCount: 2,
        fileName: 'helper.ts',
        getText: () => 'export function calculateTotal(items) {\n  return items.length;\n}',
      },
    ];

    const snippets = await gatherNeighborContext(doc() as never, new vscode.Position(0, 30));
    expect(snippets).toHaveLength(1);
  });

  it('never includes the current file', async () => {
    mockState.workspaceFiles = [uriOf('/repo/src/current.ts')];
    mockState.fileContents['/repo/src/current.ts'] = 'export function calculateTotal(items) {}';

    const snippets = await gatherNeighborContext(doc() as never, new vscode.Position(0, 30));
    expect(snippets).toEqual([]);
  });

  it('skips unreadable files without throwing', async () => {
    mockState.workspaceFiles = [uriOf('/repo/src/gone.ts')];
    // No entry in fileContents -> readFile rejects.

    await expect(
      gatherNeighborContext(doc() as never, new vscode.Position(0, 30)),
    ).resolves.toEqual([]);
  });

  it('returns an empty array when no files match', async () => {
    mockState.workspaceFiles = [];
    await expect(
      gatherNeighborContext(doc() as never, new vscode.Position(0, 30)),
    ).resolves.toEqual([]);
  });
});

describe('registerCompletionProvider neighbour wiring', () => {
  beforeEach(() => {
    resetMockState();
    mockState.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
  });

  it('installs a neighbour provider on the engine', () => {
    const stub = engineStub();
    registerCompletionProvider(
      { subscriptions: [] } as never,
      stub.engine,
      () => DEFAULT_SETTINGS,
    );
    expect(stub.setNeighborProvider).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array when the document is not open', async () => {
    const stub = engineStub();
    registerCompletionProvider(
      { subscriptions: [] } as never,
      stub.engine,
      () => DEFAULT_SETTINGS,
    );

    const provider = stub.setNeighborProvider.mock.calls[0]?.[0] as (
      document: { uri: string },
      position: { line: number; character: number },
    ) => Promise<unknown[]>;

    const result = await provider({ uri: 'file:///nope.ts' }, { line: 0, character: 0 });
    expect(result).toEqual([]);
  });

  it('caches the workspace scan between calls on the same line', async () => {
    const stub = engineStub();
    mockState.openDocuments = [doc()];
    mockState.workspaceFiles = [uriOf('/repo/src/helper.ts')];
    mockState.fileContents['/repo/src/helper.ts'] =
      'export function calculateTotal(items) { return items.length; }';

    registerCompletionProvider(
      { subscriptions: [] } as never,
      stub.engine,
      () => DEFAULT_SETTINGS,
    );

    const provider = stub.setNeighborProvider.mock.calls[0]?.[0] as (
      document: { uri: string },
      position: { line: number; character: number },
    ) => Promise<unknown[]>;

    const findFiles = vi.spyOn(vscode.workspace, 'findFiles');
    await provider({ uri: 'file:///repo/src/current.ts' }, { line: 0, character: 30 });
    await provider({ uri: 'file:///repo/src/current.ts' }, { line: 0, character: 30 });

    // Second call is served from the cache.
    expect(findFiles).toHaveBeenCalledTimes(1);
    findFiles.mockRestore();
  });

  it('rescans when the cursor moves to another line', async () => {
    const stub = engineStub();
    mockState.openDocuments = [doc()];
    mockState.workspaceFiles = [uriOf('/repo/src/helper.ts')];
    mockState.fileContents['/repo/src/helper.ts'] =
      'export function calculateTotal(items) { return items.length; }';

    registerCompletionProvider(
      { subscriptions: [] } as never,
      stub.engine,
      () => DEFAULT_SETTINGS,
    );

    const provider = stub.setNeighborProvider.mock.calls[0]?.[0] as (
      document: { uri: string },
      position: { line: number; character: number },
    ) => Promise<unknown[]>;

    const findFiles = vi.spyOn(vscode.workspace, 'findFiles');
    await provider({ uri: 'file:///repo/src/current.ts' }, { line: 0, character: 5 });
    await provider({ uri: 'file:///repo/src/current.ts' }, { line: 1, character: 5 });

    expect(findFiles).toHaveBeenCalledTimes(2);
    findFiles.mockRestore();
  });
});
