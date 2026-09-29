import { describe, expect, it } from 'vitest';
import { resolveLoggerOptions } from '@/logger/logger.js';

describe('resolveLoggerOptions', () => {
  it('sets the level from the given app log level', () => {
    expect(resolveLoggerOptions('debug', true).level).toBe('debug');
    expect(resolveLoggerOptions('warn', true).level).toBe('warn');
  });

  it('adds a pino-pretty transport outside production', () => {
    const options = resolveLoggerOptions('info', false);
    expect(options.transport).toEqual({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    });
  });

  it('omits the transport in production, since pino-pretty is a dev-only dependency', () => {
    const options = resolveLoggerOptions('info', true);
    expect(options.transport).toBeUndefined();
  });
});
