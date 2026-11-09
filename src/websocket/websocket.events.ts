import { WS_CLOSE_CODES, type ServerEvent } from '@shared';

export { WS_CLOSE_CODES };

/** Application close code: the session was resumed on another connection. */
export const CLOSE_SESSION_TAKEN_OVER = 4000;

export function serializeServerEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

/**
 * How an outbound event may be coalesced while the socket is congested:
 * - `latest-wins`: only the newest value matters (interim transcripts)
 * - `concatenate`: consecutive deltas of the same answer can be merged
 * - `ordered`: must be delivered as-is, in order
 */
export type CoalescePolicy = 'latest-wins' | 'concatenate' | 'ordered';

export function coalescePolicy(event: ServerEvent): CoalescePolicy {
  if (event.type === 'transcript.partial') return 'latest-wins';
  if (event.type === 'answer.delta') return 'concatenate';
  return 'ordered';
}
