export const PROTOCOL_VERSION = 1;

export const WS_PATH = '/ws';
export const API_PREFIX = '/api/v1';

/** Hard limit for any single WebSocket message (text or binary). */
export const WS_MAX_MESSAGE_BYTES = 256 * 1024;

/** Client heartbeat cadence; the server answers each ping with a `session.status` pong. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 15_000;

export const WS_CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
  TRY_AGAIN_LATER: 1013,
} as const;

export type WsCloseCode = (typeof WS_CLOSE_CODES)[keyof typeof WS_CLOSE_CODES];
