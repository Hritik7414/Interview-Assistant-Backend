export const CLIENT_EVENT = {
  SESSION_START: 'session.start',
  AUDIO_CHUNK: 'audio.chunk',
  SESSION_STOP: 'session.stop',
  SESSION_PING: 'session.ping',
  ANSWER_CANCEL: 'answer.cancel',
} as const;

export const SERVER_EVENT = {
  SESSION_READY: 'session.ready',
  TRANSCRIPT_PARTIAL: 'transcript.partial',
  TRANSCRIPT_FINAL: 'transcript.final',
  QUESTION_DETECTED: 'question.detected',
  ANSWER_STARTED: 'answer.started',
  ANSWER_DELTA: 'answer.delta',
  ANSWER_COMPLETED: 'answer.completed',
  SESSION_ERROR: 'session.error',
  SESSION_STATUS: 'session.status',
} as const;

export type ClientEventName = (typeof CLIENT_EVENT)[keyof typeof CLIENT_EVENT];
export type ServerEventName = (typeof SERVER_EVENT)[keyof typeof SERVER_EVENT];
