import { randomUUID } from 'node:crypto';
import type { ClientJsonEvent } from '@shared';
import type { FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { ServerConfig } from '../config/server.config';
import type { AnswerController } from '../mvc/controllers/answer.controller';
import type { AudioController } from '../mvc/controllers/audio.controller';
import type { InterviewController } from '../mvc/controllers/interview.controller';
import type { QuestionController } from '../mvc/controllers/question.controller';
import type { TranscriptController } from '../mvc/controllers/transcript.controller';
import { TokenBucket } from '../middleware/rate-limit.middleware';
import type { SessionEventSink } from '../services/interview-session.service';
import { runDetached } from '../utils/async-handler';
import { AppError, toAppError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { Clock } from '../utils/runtime';
import { parseClientMessage, type RawWsData } from '../validators/websocket.validator';
import { WebSocketClient } from './websocket.client';
import { WS_CLOSE_CODES } from './websocket.events';
import type { ConnectionContext, WebSocketSessionManager } from './websocket.session-manager';

export interface RealtimeControllers {
  interview: InterviewController;
  audio: AudioController;
  transcript: TranscriptController;
  question: QuestionController;
  answer: AnswerController;
}

const ERROR_THROTTLE_MS = 1_000;

/**
 * Transport-level router: rate-limits and validates every inbound frame, then
 * dispatches it to the MVC controllers. It also binds a session's outbound
 * events to the controllers' presenters for this connection.
 */
export class WebSocketController {
  constructor(
    private readonly deps: {
      controllers: RealtimeControllers;
      sessionManager: WebSocketSessionManager;
      config: ServerConfig['ws'];
      logger: Logger;
      now: Clock;
    },
  ) {}

  handleConnection(socket: WebSocket, request: FastifyRequest): void {
    const id = randomUUID();
    const logger = this.deps.logger.child({ connectionId: id });
    const { messageRate, outbound } = this.deps.config;
    const context: ConnectionContext = {
      id,
      client: new WebSocketClient(id, socket, outbound, logger),
      remoteAddress: request.ip,
      bucket: new TokenBucket(messageRate.capacity, messageRate.refillPerSecond, this.deps.now),
      sessionId: null,
      startPending: false,
      closed: false,
      violations: 0,
      lastErrorAt: new Map(),
    };
    this.deps.sessionManager.add(context);
    logger.debug('WebSocket connected');

    socket.on('message', (data: RawWsData, isBinary: boolean) =>
      this.handleMessage(context, data, isBinary),
    );
    socket.on('pong', () => {
      context.client.isAlive = true;
    });
    socket.on('error', (error) => logger.warn({ err: error }, 'WebSocket error'));
    socket.on('close', (code) => {
      logger.debug({ code }, 'WebSocket closed');
      runDetached(
        () => this.deps.sessionManager.remove(context, code),
        (error) => logger.error({ err: error }, 'Failed to clean up connection'),
      );
    });
  }

  private handleMessage(context: ConnectionContext, data: RawWsData, isBinary: boolean): void {
    if (!context.bucket.tryRemove()) {
      context.violations += 1;
      if (context.violations > this.deps.config.messageRate.maxViolations) {
        context.client.close(WS_CLOSE_CODES.POLICY_VIOLATION, 'Rate limit exceeded');
        return;
      }
      this.reportError(
        context,
        new AppError('RATE_LIMITED', 'Too many messages; some were dropped', { statusCode: 429 }),
      );
      return;
    }

    const parsed = parseClientMessage(data, isBinary);
    if (parsed.kind === 'invalid') {
      this.reportError(context, new AppError(parsed.code, parsed.message, { statusCode: 400 }));
      return;
    }
    if (parsed.kind === 'audio') {
      try {
        this.deps.controllers.audio.handleChunk(context, parsed.frame);
      } catch (error) {
        this.reportError(context, toAppError(error));
      }
      return;
    }
    runDetached(
      () => this.dispatch(context, parsed.event),
      (error) => this.reportError(context, toAppError(error)),
    );
  }

  private async dispatch(context: ConnectionContext, event: ClientJsonEvent): Promise<void> {
    const { interview, answer } = this.deps.controllers;
    switch (event.type) {
      case 'session.start': {
        if (context.startPending) {
          throw new AppError('SESSION_ALREADY_ACTIVE', 'A session start is already in progress', {
            statusCode: 409,
          });
        }
        context.startPending = true;
        try {
          const info = await interview.startSession(
            context,
            event.payload,
            this.createSink(context),
          );
          await this.deps.sessionManager.bindSession(context, info.sessionId);
        } finally {
          context.startPending = false;
        }
        return;
      }
      case 'session.stop':
        await interview.stopSession(context, event.payload);
        this.deps.sessionManager.unbindSession(context);
        return;
      case 'session.ping':
        interview.ping(context, event.payload, this.deps.now());
        return;
      case 'answer.cancel':
        answer.cancel(context, event.payload);
        return;
    }
  }

  /** Outbound events for this connection, rendered by the MVC controllers' presenters. */
  private createSink(context: ConnectionContext): SessionEventSink {
    const { interview, transcript, question, answer } = this.deps.controllers;
    const client = context.client;
    return {
      status: (sessionId, update) => interview.presentStatus(client, sessionId, update),
      transcriptPartial: (segment) => transcript.presentPartial(client, segment.sessionId, segment),
      transcriptFinal: (segment) => transcript.presentFinal(client, segment.sessionId, segment),
      questionDetected: (q) => question.presentDetected(client, q.sessionId, q),
      answerStarted: (a) => answer.presentStarted(client, a.sessionId, a),
      answerDelta: (a, delta, index) => answer.presentDelta(client, a.sessionId, a, delta, index),
      answerCompleted: (a) => answer.presentCompleted(client, a.sessionId, a),
      error: (error) => this.reportError(context, error),
    };
  }

  private reportError(context: ConnectionContext, error: AppError): void {
    const now = this.deps.now();
    const last = context.lastErrorAt.get(error.code) ?? 0;
    if (now - last < ERROR_THROTTLE_MS) return;
    context.lastErrorAt.set(error.code, now);
    if (error.statusCode >= 500) {
      this.deps.logger.error({ err: error, connectionId: context.id }, 'Realtime handler failed');
    }
    this.deps.controllers.interview.presentError(context.client, context.sessionId, error);
  }
}
