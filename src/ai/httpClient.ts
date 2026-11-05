/**
 * Minimal HTTP client for OpenAI-compatible endpoints.
 *
 * Implemented on top of the global `fetch` so the extension works on the
 * Node version bundled with VS Code without extra dependencies. The client
 * adds the concerns the engine cares about: timeouts, retries with jittered
 * backoff, abort propagation and error normalisation.
 */

import { TabAIError } from '../core/types.js';
import { logger } from '../core/logger.js';
import { delay } from '../core/debounce.js';

/** Options accepted by {@link requestJson}. */
export interface PostJsonOptions {
  /** Absolute URL of the endpoint. */
  url: string;
  /**
   * JSON-serialisable request body.
   *
   * Ignored for `GET` requests, which must not carry a body.
   */
  body: unknown;
  /**
   * HTTP method. Defaults to `POST`.
   *
   * `GET` is required for discovery endpoints such as `/v1/models`; some
   * servers answer a `POST` there with HTTP 200 and an error payload, which
   * would otherwise look like an empty model list.
   */
  method?: 'GET' | 'POST';
  /** Optional bearer token; when empty no `Authorization` header is sent. */
  apiKey?: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Number of retries after the first attempt. */
  maxRetries: number;
  /** Abort signal cancelling the whole operation, including retries. */
  signal?: AbortSignal;
  /** Injected fetch implementation, used by tests. */
  fetchImpl?: typeof fetch;
}

/** The parsed JSON body plus timing metadata. */
export interface PostJsonResult {
  /** Parsed response body. */
  data: unknown;
  /** HTTP status code. */
  status: number;
  /** Wall-clock duration of the successful attempt in milliseconds. */
  latencyMs: number;
}

/**
 * HTTP status codes that are worth retrying.
 *
 * `408` and `429` are transient by definition; `5xx` covers a model server
 * that is still loading or briefly overloaded.
 *
 * @param status The HTTP status code.
 * @returns True when a retry may succeed.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Computes the backoff delay before retry number `attempt` (1-based).
 *
 * Uses exponential growth with full jitter to avoid synchronised retries.
 *
 * @param attempt Retry index starting at 1.
 * @param baseMs Base delay in milliseconds.
 * @param random Injectable random source for deterministic tests.
 * @returns Delay in milliseconds.
 */
export function computeBackoffMs(
  attempt: number,
  baseMs = 250,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const ceiling = baseMs * Math.pow(2, exponent);
  return Math.floor(random() * ceiling);
}

/**
 * Reads the response body as text, tolerating empty bodies.
 *
 * @param response The fetch response.
 * @returns The body text, or an empty string.
 */
async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Extracts a human-readable error message from an OpenAI-style error payload.
 *
 * @param payload Parsed JSON body, possibly containing an `error` object.
 * @param fallback Used when no message can be extracted.
 * @returns A message safe to surface to the user.
 */
export function extractErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== 'object' || payload === null) {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  const error = record['error'];
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  const message = record['message'];
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }
  return fallback;
}

/**
 * Performs a single POST attempt and parses the JSON body.
 *
 * @param options Request options.
 * @returns The parsed body plus status and latency.
 * @throws TabAIError on network, timeout, HTTP or parse failure.
 */
async function postOnce(options: PostJsonOptions): Promise<PostJsonResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const startedAt = Date.now();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, options.timeoutMs));

  const onExternalAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      throw new TabAIError('aborted', 'Request cancelled');
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (options.apiKey !== undefined && options.apiKey.length > 0) {
    headers['Authorization'] = 'Bearer ' + options.apiKey;
  }

  const method = options.method ?? 'POST';

  try {
    const response = await fetchImpl(options.url, {
      method,
      headers,
      // A GET request must not carry a body; sending one makes some servers
      // reject the request outright.
      ...(method === 'GET' ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await readBodyText(response);
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      const message = extractErrorMessage(
        parsed,
        'HTTP ' + response.status + ' from ' + options.url,
      );
      throw new TabAIError('http', message, { statusCode: response.status });
    }

    const text = await readBodyText(response);
    let data: unknown;
    try {
      data = text.length > 0 ? JSON.parse(text) : {};
    } catch (error) {
      throw new TabAIError('parse', 'Malformed JSON response from provider', {
        cause: error,
      });
    }
    return { data, status: response.status, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof TabAIError) {
      throw error;
    }
    if (timedOut) {
      throw new TabAIError(
        'timeout',
        'Request timed out after ' + options.timeoutMs + 'ms',
        { cause: error },
      );
    }
    if (options.signal?.aborted) {
      throw new TabAIError('aborted', 'Request cancelled', { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new TabAIError('network', 'Network error: ' + message, { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * POSTs a JSON body, retrying transient failures.
 *
 * Retries are skipped for aborts and for non-retryable HTTP statuses so the
 * user is not kept waiting on an error that will not resolve itself.
 *
 * @param options Request options.
 * @returns The successful result.
 * @throws TabAIError when every attempt fails.
 */
export async function postJson(options: PostJsonOptions): Promise<PostJsonResult> {
  const attempts = Math.max(1, Math.floor(options.maxRetries) + 1);
  let lastError: TabAIError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await postOnce(options);
    } catch (error) {
      const normalised =
        error instanceof TabAIError
          ? error
          : new TabAIError('network', String(error), { cause: error });
      lastError = normalised;

      const retryable =
        normalised.kind === 'network' ||
        normalised.kind === 'timeout' ||
        (normalised.kind === 'http' &&
          normalised.statusCode !== undefined &&
          isRetryableStatus(normalised.statusCode));

      if (!retryable || attempt === attempts || options.signal?.aborted) {
        throw normalised;
      }

      const backoff = computeBackoffMs(attempt);
      logger.debug(
        'retry ' + attempt + '/' + (attempts - 1) + ' in ' + backoff + 'ms: ' + normalised.message,
      );
      await delay(backoff, options.signal);
      if (options.signal?.aborted) {
        throw new TabAIError('aborted', 'Request cancelled');
      }
    }
  }

  throw lastError ?? new TabAIError('network', 'Request failed');
}
