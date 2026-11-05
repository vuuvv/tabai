/**
 * The completion engine.
 *
 * This is the orchestration layer that mirrors the reference implementation's
 * `InlineCompFusionProvider`: it applies the two-phase debounce, consults the
 * cache, collects context, calls the provider, and post-processes the result.
 *
 * The engine has no VS Code dependency. Everything it needs about the editor
 * is passed in as a {@link DocumentSnapshot} plus a position, and cancellation
 * is expressed with the structural {@link CancellationTokenLike}. That makes
 * the entire flow testable with fake timers and a stubbed client.
 */

import type {
  CompletionContext,
  CompletionResult,
  DocumentSnapshot,
  NeighborSnippetSummary,
  ProcessedCompletion,
  TabAISettings,
  CursorPosition,
} from '../core/types.js';
import { TabAIError, isTabAIError } from '../core/types.js';
import { logger } from '../core/logger.js';
import type { CancellationTokenLike } from '../core/cancellation.js';
import { linkAbortSignal } from '../core/cancellation.js';
import { computeRemainingDebounce, delay } from '../core/debounce.js';
import { buildCompletionCacheKey } from '../core/hashing.js';
import type { LruCache } from '../core/lruCache.js';
import { createLruCache } from '../core/lruCache.js';
import { collectCompletionContext } from './context.js';
import { postProcessCompletion } from './postProcess.js';
import type { AIClient } from '../ai/client.js';

/** The outcome of one completion attempt. */
export interface CompletionOutcome {
  /** The completion to show, or `null` when nothing should be shown. */
  completion: ProcessedCompletion | null;
  /** Machine-readable reason describing why the outcome is what it is. */
  reason: string;
  /** Wall-clock duration of the whole attempt in milliseconds. */
  durationMs: number;
  /** True when the result came from the local cache. */
  fromCache: boolean;
}

/** Dependencies injected into the engine. */
export interface CompletionEngineDeps {
  /** The provider client. */
  client: Pick<AIClient, 'complete'>;
  /**
   * Optional cross-file context provider.
   *
   * Supplied by the VS Code adapter, which is the only layer that can read
   * other files. When omitted, completions use only the current document.
   */
  neighborProvider?: (
    document: DocumentSnapshot,
    position: CursorPosition,
  ) => Promise<NeighborSnippetSummary[]>;
  /** Optional injected clock, used by tests. */
  now?: () => number;
  /** Optional injected sleep, used by tests to avoid real timers. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Optional cache override, used by tests. */
  cache?: LruCache<CompletionResult>;
}

/** Reason codes emitted by the engine, kept stable for telemetry. */
export const CompletionReason = {
  /** A completion was produced successfully. */
  Ok: 'ok',
  /** The completion came from the cache. */
  Cached: 'cached',
  /** Completion is disabled in the settings. */
  Disabled: 'disabled',
  /** The request was cancelled by the caller. */
  Cancelled: 'cancelled',
  /** The cursor is not in a position worth completing. */
  Skipped: 'skipped',
  /** The model returned nothing usable. */
  Empty: 'empty',
  /** Post-processing rejected the candidate. */
  Rejected: 'rejected',
  /** The provider failed. */
  Error: 'error',
} as const;

/** Union of the {@link CompletionReason} values. */
export type CompletionReasonValue =
  (typeof CompletionReason)[keyof typeof CompletionReason];

/**
 * Computes the range that ghost text should occupy.
 *
 * The range starts at the cursor and ends where the existing line content
 * stops matching the completion. Extending it to the end of the line would be
 * simpler, but it silently deletes anything the user typed after the cursor:
 * completing `calculate` to `calculate_total` in
 * `result = calculate(a, b)` would produce `result = calculate_total` and drop
 * the arguments.
 *
 * So the range covers only the characters immediately after the cursor that
 * the completion replaces. VS Code renders the remaining text after the ghost
 * text, which is what the user expects.
 *
 * @param position Cursor position.
 * @param currentLine Text of the current line.
 * @param completionText The text that will be inserted, used to decide how much
 *   of the existing line the completion actually supersedes.
 * @returns The range for the inline completion item.
 */
export function computeInsertionRange(
  position: CursorPosition,
  currentLine: string,
  completionText = '',
): { start: CursorPosition; end: CursorPosition } {
  const cursor = Math.max(0, Math.floor(position.character));
  const tail = currentLine.slice(cursor);

  // How many characters after the cursor does the completion overwrite? Only
  // an exact character-wise continuation counts; anything else is left alone.
  let overlap = 0;
  const limit = Math.min(tail.length, completionText.length);
  while (overlap < limit && tail.charAt(overlap) === completionText.charAt(overlap)) {
    overlap += 1;
  }

  return {
    start: { line: position.line, character: cursor },
    end: { line: position.line, character: cursor + overlap },
  };
}

/**
 * Orchestrates completion requests.
 *
 * One instance is created per extension activation and reused for every
 * request; it holds the cache and nothing else mutable.
 */
export class CompletionEngine {
  /** Provider client. */
  private readonly client: Pick<AIClient, 'complete'>;

  /** Optional cross-file context provider, settable after construction. */
  private neighborProvider:
    | ((document: DocumentSnapshot, position: CursorPosition) => Promise<NeighborSnippetSummary[]>)
    | undefined;

  /** Injected clock. */
  private readonly now: () => number;

  /** Injected sleep. */
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  /** Result cache, rebuilt when the capacity setting changes. */
  private cache: LruCache<CompletionResult>;

  /** Capacity the current cache was built with. */
  private cacheCapacity: number;

  /** TTL the current cache was built with. */
  private cacheTtlMs: number;

  /** True when the caller supplied the cache and it must not be rebuilt. */
  private readonly cacheInjected: boolean;

  /**
   * @param deps Injected dependencies.
   */
  public constructor(deps: CompletionEngineDeps) {
    this.client = deps.client;
    this.neighborProvider = deps.neighborProvider;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? delay;
    this.cacheCapacity = -1;
    this.cacheTtlMs = -1;
    this.cacheInjected = deps.cache !== undefined;
    this.cache = deps.cache ?? createLruCache<CompletionResult>(0, 0);
  }

  /**
   * Ensures the cache matches the current settings.
   *
   * Rebuilding on change is cheaper than storing per-entry metadata and keeps
   * `cacheSize: 0` an effective kill switch.
   *
   * @param settings Current settings snapshot.
   */
  private syncCache(settings: TabAISettings): void {
    if (this.cacheInjected) {
      return;
    }
    if (this.cacheCapacity === settings.cacheSize && this.cacheTtlMs === settings.cacheTtlMs) {
      return;
    }
    this.cacheCapacity = settings.cacheSize;
    this.cacheTtlMs = settings.cacheTtlMs;
    this.cache = createLruCache<CompletionResult>(settings.cacheSize, settings.cacheTtlMs, this.now);
  }

  /**
   * Installs the cross-file context provider.
   *
   * Kept as a setter rather than a constructor argument because the provider
   * needs the extension's `vscode` namespace, which the engine must not
   * import; the adapter wires it up right after construction.
   *
   * @param provider Reads similar snippets from other files.
   */
  public setNeighborProvider(
    provider: (
      document: DocumentSnapshot,
      position: CursorPosition,
    ) => Promise<NeighborSnippetSummary[]>,
  ): void {
    this.neighborProvider = provider;
  }

  /**
   * Drops every cached completion.
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Returns the number of live cache entries.
   *
   * @returns The count of non-expired entries.
   */
  public cacheSize(): number {
    return this.cache.liveSize();
  }

  /**
   * Runs one completion attempt.
   *
   * Flow:
   * 1. Bail out when completion is disabled or the token is already cancelled.
   * 2. Wait the first debounce phase.
   * 3. Collect context and consult the cache.
   * 4. Wait whatever time is left of the total debounce budget.
   * 5. Issue the request and post-process the answer.
   *
   * @param document Snapshot of the document.
   * @param position Cursor position.
   * @param settings Settings snapshot.
   * @param token Optional cancellation token.
   * @returns The outcome, never throwing.
   */
  public async complete(
    document: DocumentSnapshot,
    position: CursorPosition,
    settings: TabAISettings,
    token?: CancellationTokenLike,
  ): Promise<CompletionOutcome> {
    const startedAt = this.now();
    const elapsed = (): number => this.now() - startedAt;

    if (!settings.completionEnabled) {
      logger.debug('engine: completion disabled');
      return { completion: null, reason: CompletionReason.Disabled, durationMs: 0, fromCache: false };
    }
    if (token?.isCancellationRequested === true) {
      logger.debug('engine: token already cancelled before start');
      return { completion: null, reason: CompletionReason.Cancelled, durationMs: 0, fromCache: false };
    }

    this.syncCache(settings);

    const link = linkAbortSignal(token);
    try {
      // Phase 1: short debounce so rapid keystrokes collapse into one request.
      await this.sleep(settings.contextDebounceMs, link.controller.signal);
      if (link.controller.signal.aborted) {
        logger.debug('engine: cancelled during context debounce');
        return {
          completion: null,
          reason: CompletionReason.Cancelled,
          durationMs: elapsed(),
          fromCache: false,
        };
      }

      const context = collectCompletionContext(document, position);

      // Cross-file context is gathered only when it can still change the
      // outcome: a skipped position must not pay for a workspace scan.
      if (this.neighborProvider !== undefined && settings.crossFileContext) {
        try {
          context.neighbors = await this.neighborProvider(document, position);
        } catch (error) {
          logger.debug('engine: neighbor context failed: ' + String(error));
        }
      }

      if (context.isMiddleOfLine && !settings.multiline) {
        logger.debug(
          'engine: skipped middle-of-line position with multiline disabled',
        );
        return {
          completion: null,
          reason: CompletionReason.Skipped,
          durationMs: elapsed(),
          fromCache: false,
        };
      }
      logger.debug(
        'engine: context prefix=' +
          context.prefix.length +
          ' chars suffix=' +
          context.suffix.length +
          ' chars middleOfLine=' +
          String(context.isMiddleOfLine),
      );

      const cacheKey = buildCompletionCacheKey({
        uri: document.uri,
        languageId: document.languageId,
        model: settings.completionModel,
        position,
        prefixTail: context.prefix,
        suffixHead: context.suffix,
      });

      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        const processed = this.process(cached, context, settings);
        if (processed !== null) {
          logger.debug('completion served from cache');
          return {
            completion: processed,
            reason: CompletionReason.Cached,
            durationMs: elapsed(),
            fromCache: true,
          };
        }
        this.cache.delete(cacheKey);
      }

      // Phase 2: top the wait up to the total debounce budget while the
      // context is already in hand, so context collection is free.
      const remaining = computeRemainingDebounce(settings.debounceMs, elapsed());
      if (remaining > 0) {
        await this.sleep(remaining, link.controller.signal);
      }
      if (link.controller.signal.aborted) {
        logger.debug('engine: cancelled during remaining debounce');
        return {
          completion: null,
          reason: CompletionReason.Cancelled,
          durationMs: elapsed(),
          fromCache: false,
        };
      }

      logger.debug(
        'engine: sending request after ' + elapsed() + 'ms (model=' + settings.completionModel + ')',
      );
      const result = await this.client.complete(settings, context, link.controller.signal);
      this.cache.set(cacheKey, result);

      const processed = this.process(result, context, settings);
      if (processed === null) {
        return {
          completion: null,
          reason: CompletionReason.Rejected,
          durationMs: elapsed(),
          fromCache: false,
        };
      }

      logger.debug(
        'completion ok in ' +
          (this.now() - startedAt) +
          'ms, chars=' +
          processed.text.length +
          ', multiline=' +
          String(processed.multiline),
      );
      return {
        completion: processed,
        reason: CompletionReason.Ok,
        durationMs: elapsed(),
        fromCache: false,
      };
    } catch (error) {
      if (isTabAIError(error) && error.kind === 'aborted') {
        return {
          completion: null,
          reason: CompletionReason.Cancelled,
          durationMs: elapsed(),
          fromCache: false,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('completion failed: ' + message);
      return {
        completion: null,
        reason: error instanceof TabAIError ? 'error:' + error.kind : CompletionReason.Error,
        durationMs: elapsed(),
        fromCache: false,
      };
    } finally {
      link.dispose();
    }
  }

  /**
   * Turns a raw provider result into a displayable completion.
   *
   * @param result The provider result.
   * @param context The context the result was produced for.
   * @param settings Settings snapshot.
   * @returns The processed completion, or `null` when rejected.
   */
  private process(
    result: CompletionResult,
    context: CompletionContext,
    settings: TabAISettings,
  ): ProcessedCompletion | null {
    const outcome = postProcessCompletion(result.text, {
      prefix: context.prefix,
      currentLine: context.currentLine,
      multiline: settings.multiline,
      minLength: 1,
    });

    if (outcome.text === null) {
      logger.debug('completion rejected: ' + outcome.reason);
      return null;
    }

    const text = outcome.text;
    return {
      text,
      range: computeInsertionRange(context.position, context.currentLine, text),
      multiline: text.includes('\n'),
      raw: result,
    };
  }
}
