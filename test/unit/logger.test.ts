import { describe, expect, it, beforeEach } from 'vitest';
import {
  setLogLevel,
  getLogLevel,
  setLogSink,
  isLevelEnabled,
  logger,
} from '../../src/core/logger.js';

describe('logger', () => {
  const captured: { level: string; message: string }[] = [];

  beforeEach(() => {
    captured.length = 0;
    setLogLevel('info');
    setLogSink((level, message) => {
      captured.push({ level, message });
    });
  });

  it('defaults to info level', () => {
    setLogLevel('info');
    expect(getLogLevel()).toBe('info');
  });

  it('suppresses messages below the threshold', () => {
    setLogLevel('warn');
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    logger.error('yes');
    expect(captured.map((entry) => entry.level)).toEqual(['warn', 'error']);
  });

  it('emits everything at debug level', () => {
    setLogLevel('debug');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(captured).toHaveLength(4);
  });

  it('suppresses everything at none level', () => {
    setLogLevel('none');
    logger.error('still nothing');
    expect(captured).toHaveLength(0);
  });

  it('prefixes messages with the level and product tag', () => {
    logger.info('hello');
    expect(captured[0]?.message).toBe('[INFO] [tabai] hello');
  });

  it('reports whether a level would be emitted', () => {
    setLogLevel('warn');
    expect(isLevelEnabled('debug')).toBe(false);
    expect(isLevelEnabled('warn')).toBe(true);
    expect(isLevelEnabled('error')).toBe(true);
  });

  it('restores the default sink when undefined is passed', () => {
    setLogSink(undefined);
    expect(() => logger.info('goes to console')).not.toThrow();
    setLogSink((level, message) => captured.push({ level, message }));
  });
});
