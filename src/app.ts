import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { createAiConfig, type AiConfig } from './config/ai.config';
import { loadEnv, type Env } from './config/env.config';
import { createServerConfig, type ServerConfig } from './config/server.config';
import { registerErrorHandling } from './middleware/error.middleware';
import { registerRateLimiting } from './middleware/rate-limit.middleware';
import { AnswerController } from './mvc/controllers/answer.controller';
import { AudioController } from './mvc/controllers/audio.controller';
import { HealthController } from './mvc/controllers/health.controller';
import { InterviewController } from './mvc/controllers/interview.controller';
import { QuestionController } from './mvc/controllers/question.controller';
import { TranscriptController } from './mvc/controllers/transcript.controller';
import { registerRoutes } from './mvc/routes';
import { createProviderRegistry, type ProviderCatalog } from './providers/provider.registry';
import { InMemoryAnswerRepository } from './repositories/answer.repository';
import { InMemoryInterviewRepository } from './repositories/interview.repository';
import { InMemoryQuestionRepository } from './repositories/question.repository';
import { InMemoryTranscriptRepository } from './repositories/transcript.repository';
import { AnswerGenerationService } from './services/answer-generation.service';
import { AudioStreamService } from './services/audio-stream.service';
import { InterviewSessionService } from './services/interview-session.service';
import { InterviewService } from './services/interview.service';
import { LatencyMetricsService } from './services/latency-metrics.service';
import { QuestionDetectionService } from './services/question-detection.service';
import { TranscriptionService } from './services/transcription.service';
import { createLogger, type Logger } from './utils/logger';
import { systemClock, uuidGenerator, type Clock, type IdGenerator } from './utils/runtime';
import { WebSocketController } from './websocket/websocket.controller';
import { registerWebSocketServer } from './websocket/websocket.server';
import { WebSocketSessionManager } from './websocket/websocket.session-manager';

export interface BuildAppOptions {
  env?: Env;
  logger?: Logger;
  /** Override providers (tests inject scripted or fake providers). */
  providers?: ProviderCatalog;
  /** Fine-grained config overrides applied after env parsing (tests). */
  configure?: (config: { server: ServerConfig; ai: AiConfig }) => void;
  now?: Clock;
  ids?: IdGenerator;
}

export interface AppContainer {
  config: { server: ServerConfig; ai: AiConfig };
  providers: ProviderCatalog;
  services: {
    interviews: InterviewService;
    sessions: InterviewSessionService;
    transcription: TranscriptionService;
    answers: AnswerGenerationService;
    metrics: LatencyMetricsService;
  };
  sessionManager: WebSocketSessionManager;
}

/**
 * Composition root. Dependencies flow strictly inwards:
 * transport (routes, websocket) → controllers → services → models / repository &
 * provider interfaces. Concrete repositories and providers are created only here.
 */
export async function buildApp(
  options: BuildAppOptions = {},
): Promise<{ app: FastifyInstance; container: AppContainer }> {
  const env = options.env ?? loadEnv();
  const config = { server: createServerConfig(env), ai: createAiConfig(env) };
  options.configure?.(config);
  const { server: serverConfig, ai: aiConfig } = config;
  const logger =
    options.logger ??
    createLogger({ level: serverConfig.logLevel, pretty: serverConfig.prettyLogs });
  const now = options.now ?? systemClock;
  const ids = options.ids ?? uuidGenerator;
  const startedAt = now();
  let shuttingDown = false;

  // ── Persistence (in-memory, bounded) ────────────────────────────────────────
  const { repositories: repoConfig } = serverConfig;
  const interviewRepository = new InMemoryInterviewRepository({
    maxEntries: repoConfig.maxInterviews,
  });
  const transcriptRepository = new InMemoryTranscriptRepository({
    maxPerInterview: repoConfig.maxSegmentsPerInterview,
  });
  const questionRepository = new InMemoryQuestionRepository({
    maxPerInterview: repoConfig.maxQuestionsPerInterview,
  });
  const answerRepository = new InMemoryAnswerRepository({
    maxPerInterview: repoConfig.maxAnswersPerInterview,
  });

  // ── Providers ───────────────────────────────────────────────────────────────
  const providers = options.providers ?? createProviderRegistry(aiConfig, logger);

  // ── Services ────────────────────────────────────────────────────────────────
  const metrics = new LatencyMetricsService({ windowSize: 200 });
  const interviews = new InterviewService({
    interviews: interviewRepository,
    transcripts: transcriptRepository,
    questions: questionRepository,
    answers: answerRepository,
    metrics,
    providers,
    ids,
    now,
    ttlMs: repoConfig.interviewTtlMs,
  });
  const transcription = new TranscriptionService({
    transcripts: transcriptRepository,
    metrics,
    config: aiConfig.transcription,
    logger: logger.child({ component: 'transcription' }),
    ids,
    now,
  });
  const audio = new AudioStreamService({ transcription, metrics, now });
  const detection = new QuestionDetectionService({
    config: aiConfig.questionDetection,
    questions: questionRepository,
    metrics,
    logger: logger.child({ component: 'question-detection' }),
    ids,
    now,
  });
  const answers = new AnswerGenerationService({
    answers: answerRepository,
    metrics,
    config: aiConfig.answer,
    logger: logger.child({ component: 'answer-generation' }),
    ids,
    now,
  });
  const sessions = new InterviewSessionService({
    interviews,
    audio,
    transcription,
    detection,
    answers,
    metrics,
    providers,
    config: {
      statusIntervalMs: serverConfig.session.statusIntervalMs,
      recentTranscriptChars: aiConfig.answer.recentTranscriptChars,
    },
    logger: logger.child({ component: 'session' }),
    ids,
    now,
  });

  // ── Controllers ─────────────────────────────────────────────────────────────
  const controllers = {
    health: new HealthController({
      providers,
      sessions,
      startedAt,
      now,
      isShuttingDown: () => shuttingDown,
    }),
    interview: new InterviewController({
      interviews,
      sessions,
      metrics,
      providers,
      silenceThresholdMs: aiConfig.questionDetection.silenceThresholdMs,
    }),
    audio: new AudioController({ sessions }),
    transcript: new TranscriptController({ interviews, transcription }),
    question: new QuestionController({ interviews, detection }),
    answer: new AnswerController({ interviews, answers, sessions }),
  };

  // ── Transport ───────────────────────────────────────────────────────────────
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: serverConfig.http.bodyLimitBytes,
  });

  const allowedOrigins = new Set(serverConfig.corsOrigins);
  const isOriginAllowed = (origin: string | undefined) =>
    origin === undefined || allowedOrigins.has('*') || allowedOrigins.has(origin);

  await app.register(helmet, {
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  });
  await app.register(cors, {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });
  await registerRateLimiting(app, { maxPerMinute: serverConfig.http.rateLimitPerMinute });
  registerErrorHandling(app);
  registerRoutes(app, controllers, { createPerMinute: serverConfig.http.createInterviewPerMinute });

  const sessionManager = new WebSocketSessionManager({
    sessions,
    config: {
      maxConnectionsPerIp: serverConfig.ws.maxConnectionsPerIp,
      resumeGraceMs: serverConfig.session.resumeGraceMs,
    },
    logger: logger.child({ component: 'ws-sessions' }),
  });
  const wsController = new WebSocketController({
    controllers,
    sessionManager,
    config: serverConfig.ws,
    logger: logger.child({ component: 'ws' }),
    now,
  });
  await registerWebSocketServer(app, {
    controller: wsController,
    sessionManager,
    config: serverConfig.ws,
    isOriginAllowed,
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  const sweeper = setInterval(() => {
    const purged = interviews.purgeExpired();
    if (purged.length > 0) logger.info({ count: purged.length }, 'Purged expired interviews');
  }, repoConfig.sweepIntervalMs);
  sweeper.unref();

  app.addHook('preClose', async () => {
    shuttingDown = true;
    clearInterval(sweeper);
    await sessions.stopAll('server_shutdown');
    await sessionManager.shutdown();
  });
  app.addHook('onClose', async () => {
    answers.cancelAll('session_stopped');
    await transcription.closeAll();
  });

  return {
    app,
    container: {
      config,
      providers,
      services: { interviews, sessions, transcription, answers, metrics },
      sessionManager,
    },
  };
}
