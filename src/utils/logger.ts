import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/**
 * Personal data must never reach the logs. Candidate context is additionally
 * protected by `InterviewContext.toJSON()`, which only serialises character counts.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.apiKey',
  '*.resume',
  '*.jobDescription',
  '*.instructions',
  'context.resume',
  'context.jobDescription',
  'context.instructions',
];

export interface LoggerConfig {
  level: string;
  pretty: boolean;
}

export function createLoggerOptions({ level, pretty }: LoggerConfig): LoggerOptions {
  return {
    level,
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'interview-assistant-server' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service',
            },
          },
        }
      : {}),
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return pino(createLoggerOptions(config));
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
