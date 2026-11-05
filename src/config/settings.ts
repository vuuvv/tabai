/**
 * Reads and normalises extension settings.
 *
 * All configuration access goes through {@link readSettings}. The function
 * takes a plain getter instead of importing `vscode` so the whole settings
 * surface can be unit-tested by supplying a fake getter.
 */

import type {
  LogLevelName,
  ProviderType,
  ReasoningMode,
  TabAISettings,
} from '../core/types.js';

/** The default base URL pointing at the documented local AI service. */
export const DEFAULT_BASE_URL = 'http://192.168.2.101:1234/v1';

/** The default model identifier exposed by that service. */
export const DEFAULT_MODEL = 'qwen3.6-35b-a3b';

/**
 * The complete default settings object.
 *
 * Exported so tests can assert that an empty configuration yields exactly
 * these values, and so the README table can be generated from one source.
 */
export const DEFAULT_SETTINGS: TabAISettings = {
  providerType: 'fim',
  baseUrl: DEFAULT_BASE_URL,
  apiKey: '',
  completionModel: DEFAULT_MODEL,
  commitModel: DEFAULT_MODEL,
  timeoutMs: 20000,
  maxRetries: 1,
  completionEnabled: true,
  debounceMs: 75,
  contextDebounceMs: 25,
  maxPrefixLines: 120,
  maxSuffixLines: 20,
  maxTokens: 128,
  temperature: 0.2,
  multiline: true,
  crossFileContext: true,
  reasoningMode: 'auto',
  cacheSize: 100,
  cacheTtlMs: 60000,
  gitMaxDiffChars: 12000,
  gitConventionalCommits: true,
  gitLanguage: 'en',
  gitAutoCommit: false,
  logLevel: 'info',
};

/**
 * A function that reads one configuration value by its dotted key.
 *
 * Mirrors `WorkspaceConfiguration.get` closely enough to be swappable.
 */
export type ConfigGetter = <T>(key: string, defaultValue: T) => T;

/**
 * Clamps a numeric setting into a safe range.
 *
 * A user can type any value into `settings.json`, including negatives and
 * `NaN`, so every numeric setting is normalised before use.
 *
 * @param value The raw value.
 * @param min Inclusive lower bound.
 * @param max Inclusive upper bound.
 * @param fallback Value used when the input is not a finite number.
 * @returns A finite number inside `[min, max]`.
 */
export function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalises a base URL: trims whitespace, drops trailing slashes.
 *
 * @param value The raw URL.
 * @param fallback Used when the value is empty or not a string.
 * @returns A URL without a trailing slash.
 */
export function normaliseBaseUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Normalises the provider type into one of the two supported protocols.
 *
 * @param value The raw value.
 * @param fallback Used when the value is not recognised.
 * @returns A valid provider type.
 */
export function normaliseProviderType(
  value: unknown,
  fallback: ProviderType,
): ProviderType {
  return value === 'openai-compatible' || value === 'fim' ? value : fallback;
}

/**
 * Normalises the log level setting.
 *
 * @param value The raw value.
 * @param fallback Used when the value is not recognised.
 * @returns A valid log level name.
 */
export function normaliseLogLevel(value: unknown, fallback: LogLevelName): LogLevelName {
  const allowed: LogLevelName[] = ['debug', 'info', 'warn', 'error', 'none'];
  return typeof value === 'string' && (allowed as string[]).includes(value)
    ? (value as LogLevelName)
    : fallback;
}

/**
 * Normalises the reasoning mode setting.
 *
 * @param value The raw value.
 * @param fallback Used when the value is not recognised.
 * @returns A valid reasoning mode.
 */
export function normaliseReasoningMode(
  value: unknown,
  fallback: ReasoningMode,
): ReasoningMode {
  return value === 'auto' || value === 'off' || value === 'default' ? value : fallback;
}

/**
 * Normalises the commit message language.
 *
 * @param value The raw value.
 * @param fallback Used when the value is not recognised.
 * @returns Either `en` or `zh-CN`.
 */
export function normaliseGitLanguage(
  value: unknown,
  fallback: 'en' | 'zh-CN',
): 'en' | 'zh-CN' {
  return value === 'zh-CN' || value === 'en' ? value : fallback;
}

/**
 * Reads a boolean setting.
 *
 * @param getter Configuration getter.
 * @param key Dotted setting key.
 * @param fallback Value used when the stored value is not a boolean.
 * @returns The resolved boolean.
 */
function readBoolean(getter: ConfigGetter, key: string, fallback: boolean): boolean {
  const raw = getter<unknown>(key, fallback);
  return typeof raw === 'boolean' ? raw : fallback;
}

/**
 * Reads a numeric setting with clamping.
 *
 * @param getter Configuration getter.
 * @param key Dotted setting key.
 * @param min Inclusive lower bound.
 * @param max Inclusive upper bound.
 * @param fallback Value used when the stored value is invalid.
 * @returns A clamped finite number.
 */
function readNumber(
  getter: ConfigGetter,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const raw = getter<unknown>(key, fallback);
  return clampNumber(raw, min, max, fallback);
}

/**
 * Reads a non-empty string setting.
 *
 * @param getter Configuration getter.
 * @param key Dotted setting key.
 * @param fallback Value used when the stored value is empty.
 * @returns The resolved string.
 */
function readString(getter: ConfigGetter, key: string, fallback: string): string {
  const raw = getter<unknown>(key, fallback);
  if (typeof raw !== 'string') {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

/**
 * Reads the full settings snapshot.
 *
 * Every field is normalised, so the returned object is always safe to use
 * directly. The function never throws.
 *
 * @param getter Configuration getter, typically wrapping `workspace.getConfiguration('tabai')`.
 * @returns A complete, normalised settings object.
 */
export function readSettings(getter: ConfigGetter): TabAISettings {
  const defaults = DEFAULT_SETTINGS;
  return {
    providerType: normaliseProviderType(
      getter<unknown>('tabai.provider.type', defaults.providerType),
      defaults.providerType,
    ),
    baseUrl: normaliseBaseUrl(
      getter<unknown>('tabai.provider.baseUrl', defaults.baseUrl),
      defaults.baseUrl,
    ),
    apiKey: readString(getter, 'tabai.provider.apiKey', defaults.apiKey),
    completionModel: readString(
      getter,
      'tabai.provider.completionModel',
      defaults.completionModel,
    ),
    commitModel: readString(getter, 'tabai.provider.commitModel', defaults.commitModel),
    timeoutMs: readNumber(getter, 'tabai.provider.timeoutMs', 1000, 300000, defaults.timeoutMs),
    maxRetries: Math.floor(
      readNumber(getter, 'tabai.provider.maxRetries', 0, 5, defaults.maxRetries),
    ),
    completionEnabled: readBoolean(
      getter,
      'tabai.completion.enabled',
      defaults.completionEnabled,
    ),
    debounceMs: readNumber(getter, 'tabai.completion.debounceMs', 0, 1000, defaults.debounceMs),
    contextDebounceMs: readNumber(
      getter,
      'tabai.completion.contextDebounceMs',
      0,
      500,
      defaults.contextDebounceMs,
    ),
    maxPrefixLines: Math.floor(
      readNumber(getter, 'tabai.completion.maxPrefixLines', 1, 10000, defaults.maxPrefixLines),
    ),
    maxSuffixLines: Math.floor(
      readNumber(getter, 'tabai.completion.maxSuffixLines', 0, 10000, defaults.maxSuffixLines),
    ),
    maxTokens: Math.floor(
      readNumber(getter, 'tabai.completion.maxTokens', 1, 4096, defaults.maxTokens),
    ),
    temperature: readNumber(getter, 'tabai.completion.temperature', 0, 2, defaults.temperature),
    multiline: readBoolean(getter, 'tabai.completion.multiline', defaults.multiline),
    crossFileContext: readBoolean(
      getter,
      'tabai.completion.crossFileContext',
      defaults.crossFileContext,
    ),
    reasoningMode: normaliseReasoningMode(
      getter<unknown>('tabai.completion.reasoningMode', defaults.reasoningMode),
      defaults.reasoningMode,
    ),
    cacheSize: Math.floor(
      readNumber(getter, 'tabai.completion.cacheSize', 0, 10000, defaults.cacheSize),
    ),
    cacheTtlMs: Math.floor(
      readNumber(getter, 'tabai.completion.cacheTtlMs', 0, 86400000, defaults.cacheTtlMs),
    ),
    gitMaxDiffChars: Math.floor(
      readNumber(getter, 'tabai.git.maxDiffChars', 500, 200000, defaults.gitMaxDiffChars),
    ),
    gitConventionalCommits: readBoolean(
      getter,
      'tabai.git.conventionalCommits',
      defaults.gitConventionalCommits,
    ),
    gitLanguage: normaliseGitLanguage(
      getter<unknown>('tabai.git.language', defaults.gitLanguage),
      defaults.gitLanguage,
    ),
    gitAutoCommit: readBoolean(getter, 'tabai.git.autoCommit', defaults.gitAutoCommit),
    logLevel: normaliseLogLevel(getter<unknown>('tabai.logLevel', defaults.logLevel), defaults.logLevel),
  };
}
