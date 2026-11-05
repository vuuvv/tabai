/**
 * Cancellation primitives.
 *
 * VS Code hands the extension a `CancellationToken`; the network layer wants
 * an `AbortSignal`. This module bridges the two and adds a testable token
 * implementation so the engine can be exercised without VS Code.
 */

/**
 * The minimal shape of a VS Code cancellation token.
 *
 * Declared structurally so tests can pass a plain object.
 */
export interface CancellationTokenLike {
  /** True once cancellation has been requested. */
  readonly isCancellationRequested: boolean;
  /**
   * Registers a listener fired on cancellation.
   *
   * @param listener Callback invoked once.
   * @returns An object with a `dispose` method to unregister.
   */
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * A cancellation token that can be triggered programmatically.
 *
 * Used internally and by tests. Listeners are invoked exactly once and are
 * cleared afterwards so they cannot leak.
 */
export class CancellationSource implements CancellationTokenLike {
  /** Backing flag for `isCancellationRequested`. */
  private cancelled = false;

  /** Registered listeners, cleared after firing. */
  private readonly listeners = new Set<() => void>();

  /**
   * Returns true once {@link cancel} has been called.
   *
   * @returns The cancellation state.
   */
  public get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  /**
   * Registers a cancellation listener.
   *
   * If the source is already cancelled the listener fires on the next tick,
   * matching VS Code semantics closely enough for the engine.
   *
   * @param listener Callback invoked once.
   * @returns A disposable that unregisters the listener.
   */
  public onCancellationRequested(listener: () => void): { dispose(): void } {
    if (this.cancelled) {
      queueMicrotask(listener);
      return { dispose: () => undefined };
    }
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Requests cancellation and fires every registered listener.
   */
  public cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    const pending = [...this.listeners];
    this.listeners.clear();
    for (const listener of pending) {
      try {
        listener();
      } catch {
        // A throwing listener must not prevent the others from running.
      }
    }
  }
}

/**
 * Creates an `AbortController` that aborts when the token is cancelled.
 *
 * The returned disposable removes the listener once the request completes,
 * which matters because VS Code tokens are long-lived per invocation.
 *
 * @param token The cancellation token to observe.
 * @returns The controller plus a `dispose` function to detach the listener.
 */
export function linkAbortSignal(token: CancellationTokenLike | undefined): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  if (!token) {
    return { controller, dispose: () => undefined };
  }
  if (token.isCancellationRequested) {
    controller.abort();
    return { controller, dispose: () => undefined };
  }
  const subscription = token.onCancellationRequested(() => {
    controller.abort();
  });
  return {
    controller,
    dispose: () => subscription.dispose(),
  };
}

/**
 * Throws when the token has been cancelled.
 *
 * Used at the boundary of each async stage so a cancelled request does not
 * spend more time on context collection or prompt building.
 *
 * @param token The token to inspect.
 * @param stage Human-readable stage name for the error message.
 * @throws Error when the token is cancelled.
 */
export function throwIfCancelled(
  token: CancellationTokenLike | undefined,
  stage: string,
): void {
  if (token?.isCancellationRequested) {
    throw new Error('Request cancelled during: ' + stage);
  }
}
