/**
 * Debounce helpers implementing the two-phase strategy used by TabAI.
 *
 * The reference implementation applies a short "context debounce" and then
 * tops the wait up to a total budget. This keeps perceived latency constant
 * while giving context collection a head start.
 */

/** A handle returned by {@link createDebouncer}. */
export interface Debouncer<TArgs extends unknown[]> {
  /**
   * Schedules the callback, cancelling any previously scheduled invocation.
   *
   * @param args Arguments forwarded to the callback.
   */
  call(...args: TArgs): void;

  /**
   * Cancels a pending invocation without running it.
   */
  cancel(): void;

  /**
   * Runs the callback immediately, cancelling any pending invocation.
   *
   * @param args Arguments forwarded to the callback.
   */
  flush(...args: TArgs): void;

  /** True when an invocation is currently scheduled. */
  readonly pending: boolean;
}

/**
 * Creates a trailing-edge debouncer.
 *
 * The callback runs once, `delayMs` after the last {@link Debouncer.call}.
 * Errors thrown by the callback are swallowed so one bad invocation cannot
 * break the timer loop; callers are expected to handle their own errors.
 *
 * @param callback The function to debounce.
 * @param delayMs Delay in milliseconds; values below zero are clamped to zero.
 * @returns A debouncer handle.
 */
export function createDebouncer<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delayMs: number,
): Debouncer<TArgs> {
  const delay = Math.max(0, delayMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: TArgs | undefined;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    call(...args: TArgs): void {
      lastArgs = args;
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        const pendingArgs = lastArgs;
        lastArgs = undefined;
        if (pendingArgs === undefined) {
          return;
        }
        try {
          callback(...pendingArgs);
        } catch {
          // Debounced callbacks must not throw into the timer queue.
        }
      }, delay);
    },

    cancel(): void {
      clear();
      lastArgs = undefined;
    },

    flush(...args: TArgs): void {
      clear();
      lastArgs = undefined;
      callback(...args);
    },

    get pending(): boolean {
      return timer !== undefined;
    },
  };
}

/**
 * Computes the remaining wait needed so that the total elapsed time reaches
 * the configured budget.
 *
 * This is the second half of TabAI's two-phase debounce: the engine waits
 * `contextDebounceMs` first, collects context, then sleeps for whatever time
 * is left of `totalDebounceMs`.
 *
 * @param totalDebounceMs The desired total debounce budget.
 * @param elapsedMs Time already spent since the request started.
 * @returns The remaining delay, never negative and never above the total.
 */
export function computeRemainingDebounce(
  totalDebounceMs: number,
  elapsedMs: number,
): number {
  const total = Math.max(0, totalDebounceMs);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return total;
  }
  if (elapsedMs >= total) {
    return 0;
  }
  return total - elapsedMs;
}

/**
 * Sleeps for the given number of milliseconds.
 *
 * Resolves early and without error when the provided signal aborts.
 *
 * @param ms Duration in milliseconds.
 * @param signal Optional abort signal that shortens the wait.
 * @returns A promise resolved when the timer elapses or the signal aborts.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const duration = Math.max(0, ms);
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, duration);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wraps a promise with a timeout.
 *
 * The promise is not cancelled, only abandoned; callers that care about the
 * work should pass an abort signal down to the underlying request.
 *
 * @param promise The promise to guard.
 * @param timeoutMs Budget in milliseconds.
 * @param message Optional error message used when the timeout fires.
 * @returns The resolved value, or a rejection on timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = 'Operation timed out',
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message + ' after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
