import { describe, expect, it } from 'vitest';
import { postJson } from '../../src/ai/httpClient.js';

/**
 * Captures the init object of a fetch call.
 *
 * @param body Response body to return.
 * @returns The fetch stub plus a captured-init accessor.
 */
function captureFetch(body: unknown): {
  fetchImpl: typeof fetch;
  init: () => RequestInit | undefined;
} {
  let captured: RequestInit | undefined;
  const impl = (async (_url: string, init: RequestInit) => {
    captured = init;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, init: () => captured };
}

const base = { url: 'http://host/v1/models', body: {}, timeoutMs: 1000, maxRetries: 0 };

describe('postJson HTTP method support', () => {
  it('defaults to POST with a JSON body', async () => {
    const stub = captureFetch({ ok: true });
    await postJson({ ...base, fetchImpl: stub.fetchImpl });

    expect(stub.init()?.method).toBe('POST');
    expect(stub.init()?.body).toBe('{}');
  });

  it('sends GET without a body', async () => {
    const stub = captureFetch({ data: [] });
    await postJson({ ...base, method: 'GET', fetchImpl: stub.fetchImpl });

    expect(stub.init()?.method).toBe('GET');
    expect(stub.init()?.body).toBeUndefined();
  });

  it('still sends the auth header on GET', async () => {
    const stub = captureFetch({ data: [] });
    await postJson({ ...base, method: 'GET', apiKey: 'k', fetchImpl: stub.fetchImpl });

    const headers = stub.init()?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer k');
  });
});
