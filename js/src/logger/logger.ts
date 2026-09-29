import pino, { type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '@/config/index.js';

export type { Logger } from 'pino';

/**
 * Pure mapping from app config to pino options, kept separate from `pino()`
 * itself so the level/transport decision is unit-testable without spinning
 * up a real logger (and without pino-pretty, which is dev-only and pruned
 * from the production image).
 */
export function resolveLoggerOptions(
  logLevel: AppConfig['logLevel'],
  isProduction: boolean = process.env.NODE_ENV === 'production',
): LoggerOptions {
  return {
    level: logLevel,
    ...(isProduction
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }),
  };
}

export function createLogger(logLevel: AppConfig['logLevel']): Logger {
  return pino(resolveLoggerOptions(logLevel));
}
