/**
 * A tiny, dependency-free logger.
 *
 * The extension runs in three places (extension host, unit tests, and any
 * future worker). Rather than depend on `vscode` for logging, this module
 * exposes a sink that the extension host wires to an output channel. Tests
 * can swap the sink for an in-memory recorder.
 */

/** Severity levels, ordered from most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

/** Numeric ranks used to compare levels without string lookups. */
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  none: 100,
};

/** A function that receives one formatted log line. */
export type LogSink = (level: LogLevel, message: string) => void;

/** The default sink writes to stderr so nothing is silently dropped. */
const defaultSink: LogSink = (level, message) => {
  if (level === 'error') {
    console.error(message);
  } else if (level === 'warn') {
    console.warn(message);
  } else {
    console.log(message);
  }
};

/** Mutable module state; kept private so tests must go through the API. */
let currentLevel: LogLevel = 'info';
let currentSink: LogSink = defaultSink;

/**
 * Sets the minimum level that will be emitted.
 *
 * @param level The new threshold.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Returns the currently configured level.
 *
 * @returns The active log level.
 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Replaces the sink that receives formatted lines.
 *
 * @param sink The new sink, or `undefined` to restore the default.
 */
export function setLogSink(sink: LogSink | undefined): void {
  currentSink = sink ?? defaultSink;
}

/**
 * Returns true when a message at the given level would be emitted.
 *
 * Callers use this to guard expensive string interpolation.
 *
 * @param level The level to test.
 * @returns True when the level passes the threshold.
 */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel];
}

/**
 * Emits one log line when the level passes the threshold.
 *
 * @param level Severity of the message.
 * @param message The message body.
 */
function emit(level: Exclude<LogLevel, 'none'>, message: string): void {
  if (!isLevelEnabled(level)) {
    return;
  }
  currentSink(level, '[' + level.toUpperCase() + '] [tabai] ' + message);
}

/**
 * The public logger facade. Methods are stable references so they can be
 * passed around as callbacks without losing `this`.
 */
export const logger = {
  /**
   * Logs at debug level.
   *
   * @param message The message body.
   */
  debug(message: string): void {
    emit('debug', message);
  },

  /**
   * Logs at info level.
   *
   * @param message The message body.
   */
  info(message: string): void {
    emit('info', message);
  },

  /**
   * Logs at warn level.
   *
   * @param message The message body.
   */
  warn(message: string): void {
    emit('warn', message);
  },

  /**
   * Logs at error level.
   *
   * @param message The message body.
   */
  error(message: string): void {
    emit('error', message);
  },
};
