import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normaliseLogLevel, readSettings } from '../../src/config/settings.js';
import type { ConfigGetter } from '../../src/config/settings.js';

/**
 * Builds a config getter backed by a plain object.
 *
 * @param values Overrides keyed by dotted setting name.
 * @returns A getter usable by `readSettings`.
 */
function getterFrom(values: Record<string, unknown>): ConfigGetter {
  return <T>(key: string, defaultValue: T): T => {
    const stored = values[key];
    return stored === undefined ? defaultValue : (stored as T);
  };
}

describe('normaliseLogLevel', () => {
  it('accepts every supported level', () => {
    for (const level of ['debug', 'info', 'warn', 'error', 'none'] as const) {
      expect(normaliseLogLevel(level, 'info')).toBe(level);
    }
  });

  it('falls back for an unknown level', () => {
    expect(normaliseLogLevel('verbose', 'info')).toBe('info');
    expect(normaliseLogLevel(42, 'info')).toBe('info');
    expect(normaliseLogLevel(undefined, 'info')).toBe('info');
  });
});

describe('readSettings logLevel', () => {
  it('defaults to info', () => {
    expect(readSettings(getterFrom({})).logLevel).toBe('info');
    expect(DEFAULT_SETTINGS.logLevel).toBe('info');
  });

  it('reads an explicit level', () => {
    expect(readSettings(getterFrom({ 'tabai.logLevel': 'debug' })).logLevel).toBe('debug');
  });

  it('falls back for an invalid level', () => {
    expect(readSettings(getterFrom({ 'tabai.logLevel': 'loud' })).logLevel).toBe('info');
  });
});
