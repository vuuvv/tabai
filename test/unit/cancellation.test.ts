import { describe, expect, it, vi } from 'vitest';
import {
  CancellationSource,
  linkAbortSignal,
  throwIfCancelled,
} from '../../src/core/cancellation.js';

describe('CancellationSource', () => {
  it('starts in the not-cancelled state', () => {
    const source = new CancellationSource();
    expect(source.isCancellationRequested).toBe(false);
  });

  it('flips the flag and fires listeners on cancel', () => {
    const source = new CancellationSource();
    const listener = vi.fn();
    source.onCancellationRequested(listener);
    source.cancel();
    expect(source.isCancellationRequested).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across repeated cancel calls', () => {
    const source = new CancellationSource();
    const listener = vi.fn();
    source.onCancellationRequested(listener);
    source.cancel();
    source.cancel();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire a listener that was disposed', () => {
    const source = new CancellationSource();
    const listener = vi.fn();
    const subscription = source.onCancellationRequested(listener);
    subscription.dispose();
    source.cancel();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps firing other listeners when one throws', () => {
    const source = new CancellationSource();
    const second = vi.fn();
    source.onCancellationRequested(() => {
      throw new Error('boom');
    });
    source.onCancellationRequested(second);
    expect(() => source.cancel()).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('fires immediately on an already-cancelled source', async () => {
    const source = new CancellationSource();
    source.cancel();
    const listener = vi.fn();
    source.onCancellationRequested(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('linkAbortSignal', () => {
  it('returns a live controller without a token', () => {
    const { controller, dispose } = linkAbortSignal(undefined);
    expect(controller.signal.aborted).toBe(false);
    expect(() => dispose()).not.toThrow();
  });

  it('aborts when the token is cancelled', () => {
    const source = new CancellationSource();
    const { controller } = linkAbortSignal(source);
    source.cancel();
    expect(controller.signal.aborted).toBe(true);
  });

  it('aborts immediately when the token is already cancelled', () => {
    const source = new CancellationSource();
    source.cancel();
    const { controller } = linkAbortSignal(source);
    expect(controller.signal.aborted).toBe(true);
  });

  it('detaches the listener on dispose', () => {
    const source = new CancellationSource();
    const { controller, dispose } = linkAbortSignal(source);
    dispose();
    source.cancel();
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('throwIfCancelled', () => {
  it('does nothing when the token is missing', () => {
    expect(() => throwIfCancelled(undefined, 'stage')).not.toThrow();
  });

  it('does nothing when the token is not cancelled', () => {
    const source = new CancellationSource();
    expect(() => throwIfCancelled(source, 'stage')).not.toThrow();
  });

  it('throws with the stage name when cancelled', () => {
    const source = new CancellationSource();
    source.cancel();
    expect(() => throwIfCancelled(source, 'context collection')).toThrow(
      'Request cancelled during: context collection',
    );
  });
});
