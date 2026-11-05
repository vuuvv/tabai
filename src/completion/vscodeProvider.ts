/**
 * The VS Code inline completion provider.
 *
 * This is the thin adapter between VS Code's API and {@link CompletionEngine}.
 * All logic lives in the engine; this file only converts types, checks the
 * document is one we support, and forwards cancellation.
 */

import * as vscode from 'vscode';
import type { CompletionEngine } from './engine.js';
import type {
  DocumentSnapshot,
  NeighborSnippetSummary,
  TabAISettings,
} from '../core/types.js';
import { logger } from '../core/logger.js';
import type { SourceFile } from './neighborContext.js';
import {
  buildQueryWindow,
  collectNeighborContext,
  DEFAULT_NEIGHBOR_OPTIONS,
} from './neighborContext.js';

/**
 * File extensions the neighbour scan considers.
 *
 * Restricting the list keeps the scan cheap and avoids feeding the model
 * unrelated artefacts such as lock files or minified bundles.
 */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.go', '.rs', '.java', '.kt', '.kts',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.rb', '.php', '.swift', '.scala',
  '.vue', '.svelte',
  '.sql', '.sh',
]);

/**
 * Returns true when a path looks like editable source worth reading.
 *
 * @param fsPath Absolute filesystem path.
 * @returns True for supported source files.
 */
export function isSourceFile(fsPath: string): boolean {
  const dot = fsPath.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(fsPath.slice(dot).toLowerCase());
}

/**
 * Collects cross-file context for a completion request.
 *
 * Uses `vscode.workspace.findFiles` so the user's `files.exclude` and
 * `search.exclude` settings are honoured automatically. Open documents are
 * read from the editor buffer so unsaved edits are visible.
 *
 * @param document The document being edited.
 * @param position The cursor position.
 * @returns Snippets from other files, best match first.
 */
export async function gatherNeighborContext(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<NeighborSnippetSummary[]> {
  const query = buildQueryWindow(document.getText(), position.line);

  const openFiles = new Map<string, string>();
  for (const open of vscode.workspace.textDocuments) {
    if (open.uri.scheme === 'file' && isSourceFile(open.uri.fsPath)) {
      openFiles.set(open.uri.toString(), open.getText());
    }
  }

  const include = '**/*{' + [...SOURCE_EXTENSIONS].join(',') + '}';
  let uris: vscode.Uri[] = [];
  try {
    uris = await vscode.workspace.findFiles(
      include,
      '**/node_modules/**',
      DEFAULT_NEIGHBOR_OPTIONS.maxFiles * 4,
    );
  } catch (error) {
    logger.debug('neighbor: findFiles failed: ' + String(error));
  }

  const currentUri = document.uri.toString();
  const files: SourceFile[] = [];

  for (const uri of uris) {
    const key = uri.toString();
    if (key === currentUri) {
      continue;
    }
    const cached = openFiles.get(key);
    if (cached !== undefined) {
      files.push({ path: vscode.workspace.asRelativePath(uri), text: cached });
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      files.push({ path: vscode.workspace.asRelativePath(uri), text });
    } catch {
      // A file can disappear or be unreadable between listing and reading.
    }
    if (files.length >= DEFAULT_NEIGHBOR_OPTIONS.maxFiles * 2) {
      break;
    }
  }

  const snippets = collectNeighborContext(files, {
    ...DEFAULT_NEIGHBOR_OPTIONS,
    currentPath: vscode.workspace.asRelativePath(document.uri),
    query,
  });

  return snippets.map((snippet) => ({
    path: snippet.path,
    content: snippet.content,
    startLine: snippet.startLine,
    score: snippet.score,
  }));
}

/**
 * Language ids the extension declines to complete.
 *
 * Plain-text-ish buffers produce noisy completions and would burn tokens for
 * no user value, so they are filtered out rather than disabled per language.
 */
const EXCLUDED_LANGUAGE_PATTERN = /(^|\b)(log|output|plaintext|search-result|git-commit|git-rebase)(\b|$)/i;

/**
 * Returns true when the document should be offered completions.
 *
 * @param document The document to test.
 * @returns True when the language is supported.
 */
export function isSupportedDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme === 'output' || document.uri.scheme === 'vscode-output') {
    return false;
  }
  if (document.lineCount === 0) {
    return false;
  }
  return !EXCLUDED_LANGUAGE_PATTERN.test(document.languageId);
}

/**
 * Captures the document state the engine needs.
 *
 * @param document The VS Code document.
 * @returns An immutable snapshot.
 */
export function snapshotDocument(document: vscode.TextDocument): DocumentSnapshot {
  return {
    uri: document.uri.toString(),
    languageId: document.languageId,
    version: document.version,
    text: document.getText(),
    fileName: document.fileName,
  };
}

/**
 * Registers the inline completion provider.
 *
 * @param context Extension context used for disposables.
 * @param engine The shared completion engine.
 * @param getSettings Returns the current settings snapshot.
 * @returns The disposable registration.
 */
export function registerCompletionProvider(
  context: vscode.ExtensionContext,
  engine: CompletionEngine,
  getSettings: () => TabAISettings,
): vscode.Disposable {
  /**
   * Caches workspace scans briefly.
   *
   * A completion request fires on nearly every keystroke; rescanning the
   * workspace each time would dominate the latency budget. Keying on the file
   * and line keeps the cache useful while the user types on one line, and
   * naturally invalidates when they move.
   */
  let neighborCache:
    | { key: string; at: number; value: NeighborSnippetSummary[] }
    | undefined;
  const NEIGHBOR_CACHE_MS = 3000;

  /**
   * Returns cached neighbour snippets or rescans the workspace.
   *
   * @param document The document being edited.
   * @param position The cursor position.
   * @returns Snippets from other files.
   */
  const neighborProvider = async (
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<NeighborSnippetSummary[]> => {
    const key = document.uri.toString() + ':' + String(position.line);
    const now = Date.now();
    if (
      neighborCache !== undefined &&
      neighborCache.key === key &&
      now - neighborCache.at < NEIGHBOR_CACHE_MS
    ) {
      return neighborCache.value;
    }
    const value = await gatherNeighborContext(document, position);
    neighborCache = { key, at: now, value };
    return value;
  };

  /**
   * Bridges the engine's plain-data signature to the VS Code document.
   *
   * The engine works with a `DocumentSnapshot`; this adapter looks the live
   * document back up so the scan can use `workspace.fs`.
   */
  const engineNeighborProvider = async (
    document: DocumentSnapshot,
    position: { line: number; character: number },
  ): Promise<NeighborSnippetSummary[]> => {
    const open = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === document.uri,
    );
    if (open === undefined) {
      return [];
    }
    return neighborProvider(open, new vscode.Position(position.line, position.character));
  };

  engine.setNeighborProvider(engineNeighborProvider);
  const provider: vscode.InlineCompletionItemProvider = {
    /**
     * Produces inline completion items for a position.
     *
     * @param document The document being edited.
     * @param position The cursor position.
     * @param contextData Context supplied by VS Code.
     * @param token Cancellation token.
     * @returns A list of inline completion items, or `undefined`.
     */
    async provideInlineCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
      contextData: vscode.InlineCompletionContext,
      token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionItem[] | undefined> {
      // Every early return is logged. A provider that silently returns
      // `undefined` is the hardest kind of bug to diagnose from the UI, so the
      // reason is always recorded even though it costs a string allocation.
      if (!isSupportedDocument(document)) {
        logger.debug(
          'skip: unsupported document languageId=' +
            document.languageId +
            ' scheme=' +
            document.uri.scheme,
        );
        return undefined;
      }

      const settings = getSettings();
      if (!settings.completionEnabled) {
        logger.debug('skip: completion disabled by tabai.completion.enabled');
        return undefined;
      }

      logger.debug(
        'request: line=' +
          position.line +
          ' char=' +
          position.character +
          ' lang=' +
          document.languageId +
          ' triggerKind=' +
          String(contextData.triggerKind),
      );

      const outcome = await engine.complete(
        snapshotDocument(document),
        { line: position.line, character: position.character },
        settings,
        {
          get isCancellationRequested(): boolean {
            return token.isCancellationRequested;
          },
          onCancellationRequested: (listener: () => void) => token.onCancellationRequested(listener),
        },
      );

      if (outcome.completion === null) {
        logger.debug(
          'no completion: reason=' +
            outcome.reason +
            ' duration=' +
            outcome.durationMs +
            'ms',
        );
        return undefined;
      }

      const { text, range } = outcome.completion;
      const item = new vscode.InlineCompletionItem(
        text,
        new vscode.Range(
          range.start.line,
          range.start.character,
          range.end.line,
          range.end.character,
        ),
      );

      logger.debug(
        'completion shown: reason=' +
          outcome.reason +
          ' fromCache=' +
          String(outcome.fromCache) +
          ' duration=' +
          outcome.durationMs +
          'ms triggerKind=' +
          String(contextData.triggerKind),
      );
      return [item];
    },
  };

  const selector: vscode.DocumentSelector = [
    { scheme: 'file' },
    { scheme: 'untitled' },
    { scheme: 'vscode-remote' },
    { scheme: 'vscode-notebook-cell' },
  ];

  const disposable = vscode.languages.registerInlineCompletionItemProvider(selector, provider);
  context.subscriptions.push(disposable);
  return disposable;
}
