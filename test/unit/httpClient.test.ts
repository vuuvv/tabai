import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeBackoffMs,
  extractErrorMessage,
  isRetryableStatus,
  postJson,
} from '../../src/ai/httpClient.js';

/**
 * Builds a fetch stub that returns the given responses in order.
 *
 * @param responses Sequential responses or errors to return.
 * @returns A fetch implementation plus a call counter.
 */
function sequentialFetch(
  responses: (Response | Error)[],
): { fetchImpl: typeof fetch; calls: () => number } {
  let index = 0;
  const impl = (async () => {
    const next = responses[index];
    index += 1;
    if (next === undefined) {
      throw new Error('no more stubbed responses');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, calls: () => index };
}

/**
 * Creates a JSON response.
 *
 * @param body Body object to serialise.
 * @param status HTTP status.
 * @returns A fetch Response.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('isRetryableStatus', () => {
  it('retries 408, 429 and 5xx', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it('does not retry 4xx other than 408 and 429', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('does not retry 2xx', () => {
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  it('returns zero when the random source is zero', () => {
    expect(computeBackoffMs(1, 250, () => 0)).toBe(0);
  });

  it('grows exponentially with the attempt index', () => {
    const attempt1 = computeBackoffMs(1, 100, () => 0.999);
    const attempt2 = computeBackoffMs(2, 100, () => 0.999);
    const attempt3 = computeBackoffMs(3, 100, () => 0.999);
    expect(attempt1).toBeLessThan(attempt2);
    expect(attempt2).toBeLessThan(attempt3);
  });

  it('treats attempt zero as the first attempt', () => {
    expect(computeBackoffMs(0, 100, () => 0.5)).toBe(50);
  });
});

describe('extractErrorMessage', () => {
  it('reads an OpenAI-style nested error message', () => {
    expect(extractErrorMessage({ error: { message: 'bad model' } }, 'fallback')).toBe('bad model');
  });

  it('reads a plain string error', () => {
    expect(extractErrorMessage({ error: 'boom' }, 'fallback')).toBe('boom');
  });

  it('reads a top-level message', () => {
    expect(extractErrorMessage({ message: 'nope' }, 'fallback')).toBe('nope');
  });

  it('falls back for a non-object payload', () => {
    expect(extractErrorMessage('oops', 'fallback')).toBe('fallback');
  });

  it('falls back for an empty object', () => {
    expect(extractErrorMessage({}, 'fallback')).toBe('fallback');
  });
});

describe('postJson', () => {
  const baseOptions = {
    url: 'http://localhost/v1/completions',
    body: { prompt: 'x' },
    timeoutMs: 5000,
    maxRetries: 0,
  };

  it('returns the parsed body on success', async () => {
    const stub = sequentialFetch([jsonResponse({ ok: true })]);
    const result = await postJson({ ...baseOptions, fetchImpl: stub.fetchImpl });
    expect(result.data).toEqual({ ok: true });
    expect(result.status).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the api key as a bearer token', async () => {
    let capturedHeaders: Record<string, string> = {};
    const impl = (async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await postJson({ ...baseOptions, apiKey: 'secret', fetchImpl: impl });
    expect(capturedHeaders['Authorization']).toBe('Bearer secret');
  });

  it('omits the auth header when the key is empty', async () => {
    let capturedHeaders: Record<string, string> = {};
    const impl = (async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await postJson({ ...baseOptions, apiKey: '', fetchImpl: impl });
    expect(capturedHeaders['Authorization']).toBeUndefined();
  });

  it('throws a normalised http error with the server message', async () => {
    const stub = sequentialFetch([jsonResponse({ error: { message: 'no such model' } }, 404)]);
    await expect(postJson({ ...baseOptions, fetchImpl: stub.fetchImpl })).rejects.toMatchObject({
      kind: 'http',
      statusCode: 404,
      message: 'no such model',
    });
  });

  it('handles a non-JSON error body', async () => {
    const stub = sequentialFetch([new Response('<html>oops</html>', { status: 502 })]);
    await expect(postJson({ ...baseOptions, fetchImpl: stub.fetchImpl })).rejects.toMatchObject({
      kind: 'http',
      statusCode: 502,
    });
  });

  it('throws a parse error for malformed JSON', async () => {
    const stub = sequentialFetch([new Response('not json', { status: 200 })]);
    await expect(postJson({ ...baseOptions, fetchImpl: stub.fetchImpl })).rejects.toMatchObject({
      kind: 'parse',
    });
  });

  it('accepts an empty body as an empty object', async () => {
    const stub = sequentialFetch([new Response('', { status: 200 })]);
    const result = await postJson({ ...baseOptions, fetchImpl: stub.fetchImpl });
    expect(result.data).toEqual({});
  });

  it('throws a network error when fetch rejects', async () => {
    const stub = sequentialFetch([new TypeError('fetch failed')]);
    await expect(postJson({ ...baseOptions, fetchImpl: stub.fetchImpl })).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('retries a retryable status then succeeds', async () => {
    const stub = sequentialFetch([
      jsonResponse({ error: 'overloaded' }, 503),
      jsonResponse({ ok: true }),
    ]);
    const result = await postJson({
      ...baseOptions,
      maxRetries: 1,
      fetchImpl: stub.fetchImpl,
    });
    expect(result.data).toEqual({ ok: true });
    expect(stub.calls()).toBe(2);
  });

  it('does not retry a non-retryable status', async () => {
    const stub = sequentialFetch([jsonResponse({ error: 'bad request' }, 400)]);
    await expect(
      postJson({ ...baseOptions, maxRetries: 3, fetchImpl: stub.fetchImpl }),
    ).rejects.toMatchObject({ kind: 'http', statusCode: 400 });
    expect(stub.calls()).toBe(1);
  });

  it('gives up after exhausting retries', async () => {
    const stub = sequentialFetch([
      jsonResponse({ error: 'down' }, 500),
      jsonResponse({ error: 'down' }, 500),
    ]);
    await expect(
      postJson({ ...baseOptions, maxRetries: 1, fetchImpl: stub.fetchImpl }),
    ).rejects.toMatchObject({ kind: 'http', statusCode: 500 });
    expect(stub.calls()).toBe(2);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = sequentialFetch([jsonResponse({})]);
    await expect(
      postJson({ ...baseOptions, signal: controller.signal, fetchImpl: stub.fetchImpl }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });

  describe('timeouts', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('aborts and reports a timeout', async () => {
      const impl = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        })) as unknown as typeof fetch;

      const promise = postJson({ ...baseOptions, timeoutMs: 100, fetchImpl: impl });
      const assertion = expect(promise).rejects.toMatchObject({ kind: 'timeout' });
      vi.advanceTimersByTime(150);
      await assertion;
    });
  });
});
