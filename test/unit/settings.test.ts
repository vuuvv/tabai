import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_SETTINGS,
  clampNumber,
  normaliseBaseUrl,
  normaliseGitLanguage,
  normaliseProviderType,
  normaliseReasoningMode,
  readSettings,
} from '../../src/config/settings.js';
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

describe('clampNumber', () => {
  it('passes a value inside the range through', () => {
    expect(clampNumber(50, 0, 100, 10)).toBe(50);
  });

  it('clamps below the minimum', () => {
    expect(clampNumber(-5, 0, 100, 10)).toBe(0);
  });

  it('clamps above the maximum', () => {
    expect(clampNumber(500, 0, 100, 10)).toBe(100);
  });

  it('falls back for a non-number', () => {
    expect(clampNumber('50', 0, 100, 10)).toBe(10);
  });

  it('falls back for NaN and Infinity', () => {
    expect(clampNumber(Number.NaN, 0, 100, 10)).toBe(10);
    expect(clampNumber(Number.POSITIVE_INFINITY, 0, 100, 10)).toBe(10);
  });
});

describe('normaliseBaseUrl', () => {
  it('trims whitespace', () => {
    expect(normaliseBaseUrl('  http://a/v1  ', 'x')).toBe('http://a/v1');
  });

  it('strips trailing slashes', () => {
    expect(normaliseBaseUrl('http://a/v1///', 'x')).toBe('http://a/v1');
  });

  it('falls back for an empty string', () => {
    expect(normaliseBaseUrl('   ', 'fallback')).toBe('fallback');
  });

  it('falls back for a non-string', () => {
    expect(normaliseBaseUrl(42, 'fallback')).toBe('fallback');
  });
});

describe('normaliseProviderType', () => {
  it('accepts the two supported values', () => {
    expect(normaliseProviderType('fim', 'openai-compatible')).toBe('fim');
    expect(normaliseProviderType('openai-compatible', 'fim')).toBe('openai-compatible');
  });

  it('falls back for anything else', () => {
    expect(normaliseProviderType('grpc', 'fim')).toBe('fim');
    expect(normaliseProviderType(undefined, 'fim')).toBe('fim');
  });
});

describe('normaliseReasoningMode', () => {
  it('accepts the three supported values', () => {
    expect(normaliseReasoningMode('auto', 'default')).toBe('auto');
    expect(normaliseReasoningMode('off', 'default')).toBe('off');
    expect(normaliseReasoningMode('default', 'auto')).toBe('default');
  });

  it('falls back otherwise', () => {
    expect(normaliseReasoningMode('always', 'auto')).toBe('auto');
    expect(normaliseReasoningMode(undefined, 'auto')).toBe('auto');
  });
});

describe('normaliseGitLanguage', () => {
  it('accepts en and zh-CN', () => {
    expect(normaliseGitLanguage('en', 'zh-CN')).toBe('en');
    expect(normaliseGitLanguage('zh-CN', 'en')).toBe('zh-CN');
  });

  it('falls back otherwise', () => {
    expect(normaliseGitLanguage('fr', 'en')).toBe('en');
  });
});

describe('readSettings', () => {
  it('returns the documented defaults for an empty configuration', () => {
    const settings = readSettings(getterFrom({}));
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('points at the local AI service by default', () => {
    const settings = readSettings(getterFrom({}));
    expect(settings.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(settings.baseUrl).toBe('http://192.168.2.101:1234/v1');
    expect(settings.completionModel).toBe(DEFAULT_MODEL);
  });

  it('applies overrides', () => {
    const settings = readSettings(
      getterFrom({
        'tabai.provider.baseUrl': 'http://other:8080/v1/',
        'tabai.provider.completionModel': 'my-model',
        'tabai.completion.maxTokens': 512,
        'tabai.completion.multiline': false,
        'tabai.git.language': 'zh-CN',
      }),
    );
    expect(settings.baseUrl).toBe('http://other:8080/v1');
    expect(settings.completionModel).toBe('my-model');
    expect(settings.maxTokens).toBe(512);
    expect(settings.multiline).toBe(false);
    expect(settings.gitLanguage).toBe('zh-CN');
  });

  it('clamps out-of-range numbers', () => {
    const settings = readSettings(
      getterFrom({
        'tabai.provider.timeoutMs': 10,
        'tabai.completion.temperature': 99,
        'tabai.completion.debounceMs': -50,
      }),
    );
    expect(settings.timeoutMs).toBe(1000);
    expect(settings.temperature).toBe(2);
    expect(settings.debounceMs).toBe(0);
  });

  it('floors fractional integers', () => {
    const settings = readSettings(
      getterFrom({
        'tabai.completion.maxPrefixLines': 10.9,
        'tabai.provider.maxRetries': 2.7,
      }),
    );
    expect(settings.maxPrefixLines).toBe(10);
    expect(settings.maxRetries).toBe(2);
  });

  it('ignores a non-boolean boolean setting', () => {
    const settings = readSettings(getterFrom({ 'tabai.completion.enabled': 'yes' }));
    expect(settings.completionEnabled).toBe(true);
  });

  it('ignores a non-string string setting', () => {
    const settings = readSettings(getterFrom({ 'tabai.provider.completionModel': 123 }));
    expect(settings.completionModel).toBe(DEFAULT_MODEL);
  });

  it('treats an empty string as unset', () => {
    const settings = readSettings(getterFrom({ 'tabai.provider.apiKey': '   ' }));
    expect(settings.apiKey).toBe('');
  });

  it('caps maxRetries at five', () => {
    const settings = readSettings(getterFrom({ 'tabai.provider.maxRetries': 99 }));
    expect(settings.maxRetries).toBe(5);
  });

  it('allows disabling the cache', () => {
    const settings = readSettings(getterFrom({ 'tabai.completion.cacheSize': 0 }));
    expect(settings.cacheSize).toBe(0);
  });

  it('normalises an unknown provider type', () => {
    const settings = readSettings(getterFrom({ 'tabai.provider.type': 'carrier-pigeon' }));
    expect(settings.providerType).toBe('fim');
  });

  it('defaults reasoning mode to auto', () => {
    expect(readSettings(getterFrom({})).reasoningMode).toBe('auto');
  });

  it('accepts the supported reasoning modes', () => {
    expect(readSettings(getterFrom({ 'tabai.completion.reasoningMode': 'default' })).reasoningMode).toBe(
      'default',
    );
    expect(readSettings(getterFrom({ 'tabai.completion.reasoningMode': 'off' })).reasoningMode).toBe(
      'off',
    );
  });

  it('falls back for an unknown reasoning mode', () => {
    expect(
      readSettings(getterFrom({ 'tabai.completion.reasoningMode': 'sometimes' })).reasoningMode,
    ).toBe('auto');
  });
});
