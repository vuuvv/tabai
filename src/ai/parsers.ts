/**
 * Response parsers for OpenAI-compatible payloads.
 *
 * The provider layer calls these to turn a raw JSON body into a normalised
 * result. Keeping parsing separate makes it possible to unit-test every
 * malformed-payload case without a network.
 */

import { TabAIError } from '../core/types.js';

/** A completion extracted from a `/completions` response. */
export interface ParsedTextCompletion {
  /** The generated text. */
  text: string;
  /** Why generation stopped. */
  finishReason: string;
  /** The model reported by the server. */
  model: string;
}

/** A message extracted from a `/chat/completions` response. */
export interface ParsedChatCompletion {
  /** The assistant message content. */
  content: string;
  /** Why generation stopped. */
  finishReason: string;
  /** The model reported by the server. */
  model: string;
}

/**
 * Narrows an unknown value to a non-null object record.
 *
 * @param value Any value.
 * @returns True when the value is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the first entry of a `choices` array.
 *
 * @param payload The response body.
 * @returns The first choice object, or `undefined`.
 */
function firstChoice(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const choices = payload['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const first: unknown = choices[0];
  return isRecord(first) ? first : undefined;
}

/**
 * Parses a `/v1/completions` response body.
 *
 * @param payload The parsed JSON body.
 * @returns The normalised completion.
 * @throws TabAIError when the payload has no usable choice.
 */
export function parseTextCompletion(payload: unknown): ParsedTextCompletion {
  const choice = firstChoice(payload);
  if (choice === undefined) {
    throw new TabAIError('parse', 'Provider response contains no choices');
  }
  const text = choice['text'];
  if (typeof text !== 'string') {
    throw new TabAIError('parse', 'Provider response choice has no text');
  }
  const finishReason = choice['finish_reason'];
  const model = isRecord(payload) ? payload['model'] : undefined;
  return {
    text,
    finishReason: typeof finishReason === 'string' ? finishReason : 'unknown',
    model: typeof model === 'string' ? model : 'unknown',
  };
}

/**
 * Parses a `/v1/chat/completions` response body.
 *
 * Reasoning models emit their chain of thought into `reasoning_content`;
 * that field is intentionally ignored, only `content` is used.
 *
 * @param payload The parsed JSON body.
 * @returns The normalised message.
 * @throws TabAIError when the payload has no usable message.
 */
export function parseChatCompletion(payload: unknown): ParsedChatCompletion {
  const choice = firstChoice(payload);
  if (choice === undefined) {
    throw new TabAIError('parse', 'Provider response contains no choices');
  }
  const message = choice['message'];
  if (!isRecord(message)) {
    throw new TabAIError('parse', 'Provider response choice has no message');
  }
  const content = message['content'];
  if (typeof content !== 'string') {
    throw new TabAIError('parse', 'Provider response message has no content');
  }
  const finishReason = choice['finish_reason'];
  const model = isRecord(payload) ? payload['model'] : undefined;
  return {
    content,
    finishReason: typeof finishReason === 'string' ? finishReason : 'unknown',
    model: typeof model === 'string' ? model : 'unknown',
  };
}

/**
 * Extracts the model ids from a `/v1/models` response.
 *
 * @param payload The parsed JSON body.
 * @returns Model identifiers in server order.
 */
export function parseModelList(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  // OpenAI shape is `{ data: [...] }`. LM Studio's native `/api/v1/models`
  // returns `{ models: [...] }` instead, so both are accepted.
  const collection = Array.isArray(payload['data'])
    ? payload['data']
    : Array.isArray(payload['models'])
      ? payload['models']
      : undefined;
  if (collection === undefined) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of collection) {
    if (isRecord(entry)) {
      // OpenAI entries use `id`; LM Studio's native shape uses `key`.
      const id = entry['id'] ?? entry['key'] ?? entry['model_key'];
      if (typeof id === 'string' && id.length > 0) {
        ids.push(id);
      }
    }
  }
  return ids;
}
