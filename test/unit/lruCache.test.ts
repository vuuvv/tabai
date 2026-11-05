import { describe, expect, it } from 'vitest';
import { createLruCache } from '../../src/core/lruCache.js';

describe('createLruCache', () => {
  it('stores and reads values', () => {
    const cache = createLruCache<string>(10, 0);
    cache.set('a', '1');
    expect(cache.get('a')).toBe('1');
  });

  it('returns undefined for a missing key', () => {
    const cache = createLruCache<string>(10, 0);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used entry', () => {
    const cache = createLruCache<number>(2, 0);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // refresh "a"
    cache.set('c', 3); // evicts "b"
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('reports its size', () => {
    const cache = createLruCache<number>(5, 0);
    expect(cache.size).toBe(0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);
  });

  it('expires entries after the ttl', () => {
    let now = 1000;
    const cache = createLruCache<string>(10, 500, () => now);
    cache.set('a', '1');
    now = 1499;
    expect(cache.get('a')).toBe('1');
    now = 1500;
    expect(cache.get('a')).toBeUndefined();
  });

  it('never expires when the ttl is zero', () => {
    let now = 0;
    const cache = createLruCache<string>(10, 0, () => now);
    cache.set('a', '1');
    now = 1e12;
    expect(cache.get('a')).toBe('1');
  });

  it('disables itself at zero capacity', () => {
    const cache = createLruCache<string>(0, 0);
    cache.set('a', '1');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
  });

  it('reports has() without refreshing recency', () => {
    const cache = createLruCache<number>(2, 0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.has('a')).toBe(true);
    cache.set('c', 3);
    // "a" was still the LRU because has() did not refresh it.
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  it('has() returns false for an expired entry', () => {
    let now = 0;
    const cache = createLruCache<string>(10, 100, () => now);
    cache.set('a', '1');
    now = 200;
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('deletes entries', () => {
    const cache = createLruCache<number>(5, 0);
    cache.set('a', 1);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.get('a')).toBeUndefined();
  });

  it('clears every entry', () => {
    const cache = createLruCache<number>(5, 0);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('counts only live entries with liveSize()', () => {
    let now = 0;
    const cache = createLruCache<string>(10, 100, () => now);
    cache.set('a', '1');
    now = 50;
    cache.set('b', '2');
    // At t=150 the first entry (expiry 100) is gone and the second
    // (expiry 150) has just reached its expiry boundary, so nothing is live.
    now = 150;
    expect(cache.size).toBe(2);
    expect(cache.liveSize()).toBe(0);

    // One millisecond earlier the second entry is still live.
    now = 149;
    expect(cache.liveSize()).toBe(1);
  });

  it('overwrites an existing key without growing', () => {
    const cache = createLruCache<string>(5, 0);
    cache.set('a', '1');
    cache.set('a', '2');
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe('2');
  });

  it('floors a fractional capacity', () => {
    const cache = createLruCache<number>(2.9, 0);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(2);
  });
});
