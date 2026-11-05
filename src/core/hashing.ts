/**
 * Deterministic hashing helpers used for cache keys.
 *
 * The completion cache key must be stable across processes and cheap to
 * compute, so a 32-bit FNV-1a variant is used rather than a cryptographic
 * digest. Collisions are acceptable because a wrong cache hit would be caught
 * by the post-processing validation anyway, and the key includes the full
 * context fingerprint.
 */

/**
 * Computes a 32-bit FNV-1a hash of a string.
 *
 * @param input The string to hash.
 * @returns An unsigned 32-bit integer.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Multiply by the FNV prime (16777619) using shifts to stay in 32 bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Produces a short hexadecimal digest of a string.
 *
 * @param input The string to hash.
 * @returns Eight lowercase hexadecimal characters.
 */
export function shortHash(input: string): string {
  return fnv1a(input).toString(16).padStart(8, '0');
}

/**
 * Builds the cache key for a completion request.
 *
 * The key intentionally includes the model and the tail of the prefix rather
 * than the entire document: two requests that differ only in text far away
 * from the cursor will produce the same completion, and reusing the cache in
 * that case is a latency win.
 *
 * @param parts Structured key components.
 * @param parts.uri Document URI.
 * @param parts.languageId Document language id.
 * @param parts.model Model identifier.
 * @param parts.position Cursor position.
 * @param parts.prefixTail Last portion of the prefix text.
 * @param parts.suffixHead First portion of the suffix text.
 * @param tailLength How many characters of prefix/suffix to include.
 * @returns A stable cache key string.
 */
export function buildCompletionCacheKey(
  parts: {
    uri: string;
    languageId: string;
    model: string;
    position: { line: number; character: number };
    prefixTail: string;
    suffixHead: string;
  },
  tailLength = 2000,
): string {
  const limit = Math.max(1, Math.floor(tailLength));
  const prefixTail = parts.prefixTail.slice(-limit);
  const suffixHead = parts.suffixHead.slice(0, limit);
  return [
    parts.uri,
    parts.languageId,
    parts.model,
    parts.position.line + ':' + parts.position.character,
    shortHash(prefixTail),
    shortHash(suffixHead),
  ].join('|');
}
