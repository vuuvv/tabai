/**
 * A small LRU cache with per-entry time-to-live.
 *
 * Completion results are cached by a key derived from the document, cursor and
 * settings. Because the model output for the same context is deterministic
 * enough, serving a cached value removes an entire network round trip while
 * the user keeps typing at the same spot.
 *
 * The implementation uses `Map` insertion order to track recency: reading an
 * entry deletes and re-inserts it, so the first key is always the least
 * recently used.
 */

/** A cached value together with its expiry timestamp. */
interface CacheEntry<T> {
  /** The stored value. */
  value: T;
  /** Epoch milliseconds after which the entry is considered stale. */
  expiresAt: number;
}

/** Public surface of the cache. */
export interface LruCache<T> {
  /**
   * Reads a value, refreshing its recency.
   *
   * @param key Cache key.
   * @returns The value, or `undefined` when missing or expired.
   */
  get(key: string): T | undefined;

  /**
   * Stores a value.
   *
   * @param key Cache key.
   * @param value Value to store.
   */
  set(key: string, value: T): void;

  /**
   * Returns true when a non-expired entry exists, without refreshing recency.
   *
   * @param key Cache key.
   * @returns True when the key is present and fresh.
   */
  has(key: string): boolean;

  /**
   * Removes one entry.
   *
   * @param key Cache key.
   * @returns True when an entry was removed.
   */
  delete(key: string): boolean;

  /** Removes every entry. */
  clear(): void;

  /** Number of entries currently stored, including expired ones. */
  readonly size: number;

  /**
   * Returns the number of entries that have not yet expired.
   *
   * @returns The count of fresh entries.
   */
  liveSize(): number;
}

/**
 * Creates an LRU cache.
 *
 * @param capacity Maximum number of entries; values below 1 disable caching
 *   entirely so the cache always misses.
 * @param ttlMs Time-to-live per entry in milliseconds. Zero means "never
 *   expires".
 * @param now Injectable clock, used by tests to avoid real timers.
 * @returns A cache instance.
 */
export function createLruCache<T>(
  capacity: number,
  ttlMs: number,
  now: () => number = Date.now,
): LruCache<T> {
  const limit = Math.max(0, Math.floor(capacity));
  const ttl = Math.max(0, ttlMs);
  const store = new Map<string, CacheEntry<T>>();

  /**
   * Returns true when the entry has passed its expiry time.
   *
   * @param entry The entry to inspect.
   * @returns True when stale.
   */
  const isExpired = (entry: CacheEntry<T>): boolean =>
    ttl > 0 && now() >= entry.expiresAt;

  return {
    get(key: string): T | undefined {
      if (limit === 0) {
        return undefined;
      }
      const entry = store.get(key);
      if (entry === undefined) {
        return undefined;
      }
      if (isExpired(entry)) {
        store.delete(key);
        return undefined;
      }
      // Refresh recency by moving the key to the end of the insertion order.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },

    set(key: string, value: T): void {
      if (limit === 0) {
        return;
      }
      store.delete(key);
      store.set(key, { value, expiresAt: now() + ttl });
      while (store.size > limit) {
        const oldest = store.keys().next();
        if (oldest.done === true) {
          break;
        }
        store.delete(oldest.value);
      }
    },

    has(key: string): boolean {
      if (limit === 0) {
        return false;
      }
      const entry = store.get(key);
      if (entry === undefined) {
        return false;
      }
      if (isExpired(entry)) {
        store.delete(key);
        return false;
      }
      return true;
    },

    delete(key: string): boolean {
      return store.delete(key);
    },

    clear(): void {
      store.clear();
    },

    get size(): number {
      return store.size;
    },

    liveSize(): number {
      let count = 0;
      for (const entry of store.values()) {
        if (!isExpired(entry)) {
          count += 1;
        }
      }
      return count;
    },
  };
}
