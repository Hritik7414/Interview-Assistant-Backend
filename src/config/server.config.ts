import { WS_MAX_MESSAGE_BYTES, WS_PATH } from '@shared';
import type { Env } from './env.config';

export interface ServerConfig {
  env: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  prettyLogs: boolean;
  corsOrigins: string[];
  http: {
    bodyLimitBytes: number;
    rateLimitPerMinute: number;
    createInterviewPerMinute: number;
  };
  ws: {
    path: string;
    maxMessageBytes: number;
    maxConnectionsPerIp: number;
    /** Transport-level ping/pong used to detect dead TCP connections. */
    heartbeatIntervalMs: number;
    /** Token bucket for inbound messages (audio at 20 fps + control traffic). */
    messageRate: { capacity: number; refillPerSecond: number; maxViolations: number };
    /** Outbound backpressure: coalesce/queue once the socket buffer exceeds the high-water mark. */
    outbound: { highWaterMarkBytes: number; maxQueuedEvents: number; flushIntervalMs: number };
  };
  session: {
    resumeGraceMs: number;
    statusIntervalMs: number;
  };
  repositories: {
    maxInterviews: number;
    interviewTtlMs: number;
    maxSegmentsPerInterview: number;
    maxQuestionsPerInterview: number;
    maxAnswersPerInterview: number;
    sweepIntervalMs: number;
  };
}

export function createServerConfig(env: Env): ServerConfig {
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    prettyLogs: env.LOG_PRETTY ?? env.NODE_ENV === 'development',
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    http: {
      bodyLimitBytes: 256 * 1024,
      rateLimitPerMinute: env.RATE_LIMIT_MAX_PER_MINUTE,
      createInterviewPerMinute: Math.max(1, Math.floor(env.RATE_LIMIT_MAX_PER_MINUTE / 4)),
    },
    ws: {
      path: WS_PATH,
      maxMessageBytes: WS_MAX_MESSAGE_BYTES,
      maxConnectionsPerIp: env.WS_MAX_CONNECTIONS_PER_IP,
      heartbeatIntervalMs: 15_000,
      messageRate: { capacity: 120, refillPerSecond: 60, maxViolations: 500 },
      outbound: { highWaterMarkBytes: 1024 * 1024, maxQueuedEvents: 2_000, flushIntervalMs: 25 },
    },
    session: {
      resumeGraceMs: env.SESSION_RESUME_GRACE_MS,
      statusIntervalMs: 2_000,
    },
    repositories: {
      maxInterviews: 500,
      interviewTtlMs: 2 * 60 * 60 * 1000,
      maxSegmentsPerInterview: 5_000,
      maxQuestionsPerInterview: 500,
      maxAnswersPerInterview: 500,
      sweepIntervalMs: 5 * 60 * 1000,
    },
  };
}
