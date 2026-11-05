import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeRemainingDebounce,
  createDebouncer,
  delay,
  withTimeout,
} from '../../src/core/debounce.js';

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the callback once after the delay', () => {
    const callback = vi.fn();
    const debouncer = createDebouncer(callback, 50);
    debouncer.call('a');
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('a');
  });

  it('collapses rapid calls into the last one', () => {
    const callback = vi.fn();
    const debouncer = createDebouncer(callback, 50);
    debouncer.call(1);
    vi.advanceTimersByTime(20);
    debouncer.call(2);
    vi.advanceTimersByTime(20);
    debouncer.call(3);
    vi.advanceTimersByTime(49);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(3);
  });

  it('reports pending state', () => {
    const debouncer = createDebouncer(() => undefined, 10);
    expect(debouncer.pending).toBe(false);
    debouncer.call();
    expect(debouncer.pending).toBe(true);
    vi.advanceTimersByTime(10);
    expect(debouncer.pending).toBe(false);
  });

  it('cancels a pending call', () => {
    const callback = vi.fn();
    const debouncer = createDebouncer(callback, 10);
    debouncer.call();
    debouncer.cancel();
    vi.advanceTimersByTime(100);
    expect(callback).not.toHaveBeenCalled();
    expect(debouncer.pending).toBe(false);
  });

  it('flushes immediately', () => {
    const callback = vi.fn();
    const debouncer = createDebouncer(callback, 1000);
    debouncer.call('pending');
    debouncer.flush('immediate');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('immediate');
    vi.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('swallows callback errors', () => {
    const debouncer = createDebouncer(() => {
      throw new Error('boom');
    }, 10);
    debouncer.call();
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
  });

  it('clamps a negative delay to zero', () => {
    const callback = vi.fn();
    const debouncer = createDebouncer(callback, -50);
    debouncer.call();
    vi.advanceTimersByTime(0);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe('computeRemainingDebounce', () => {
  it('returns the full budget when nothing has elapsed', () => {
    expect(computeRemainingDebounce(75, 0)).toBe(75);
  });

  it('subtracts elapsed time', () => {
    expect(computeRemainingDebounce(75, 25)).toBe(50);
  });

  it('never returns a negative value', () => {
    expect(computeRemainingDebounce(75, 500)).toBe(0);
  });

  it('handles a non-finite elapsed value', () => {
    expect(computeRemainingDebounce(75, Number.NaN)).toBe(75);
  });

  it('clamps a negative budget to zero', () => {
    expect(computeRemainingDebounce(-10, 0)).toBe(0);
  });

  it('returns zero when elapsed equals the budget', () => {
    expect(computeRemainingDebounce(75, 75)).toBe(0);
  });
});

describe('delay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the requested time', async () => {
    let done = false;
    const promise = delay(100).then(() => {
      done = true;
    });
    vi.advanceTimersByTime(99);
    await Promise.resolve();
    expect(done).toBe(false);
    vi.advanceTimersByTime(1);
    await promise;
    expect(done).toBe(true);
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(1000, controller.signal)).resolves.toBeUndefined();
  });

  it('resolves early when the signal aborts', async () => {
    const controller = new AbortController();
    const promise = delay(1000, controller.signal);
    controller.abort();
    await expect(promise).resolves.toBeUndefined();
  });

  it('clamps a negative duration to zero', async () => {
    const promise = delay(-10);
    vi.advanceTimersByTime(0);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when the promise wins', async () => {
    const promise = withTimeout(Promise.resolve('ok'), 1000);
    await expect(promise).resolves.toBe('ok');
  });

  it('rejects when the timeout wins', async () => {
    const never = new Promise<string>(() => undefined);
    const promise = withTimeout(never, 100, 'too slow');
    const assertion = expect(promise).rejects.toThrow('too slow after 100ms');
    vi.advanceTimersByTime(100);
    await assertion;
  });

  it('propagates a rejection from the guarded promise', async () => {
    const failing = Promise.reject(new Error('inner'));
    await expect(withTimeout(failing, 1000)).rejects.toThrow('inner');
  });

  it('skips the timer for a non-positive timeout', async () => {
    await expect(withTimeout(Promise.resolve(1), 0)).resolves.toBe(1);
  });
});
