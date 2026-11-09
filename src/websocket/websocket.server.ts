import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config/server.config';
import type { WebSocketController } from './websocket.controller';
import type { WebSocketSessionManager } from './websocket.session-manager';

export interface WebSocketServerDeps {
  controller: WebSocketController;
  sessionManager: WebSocketSessionManager;
  config: ServerConfig['ws'];
  isOriginAllowed: (origin: string | undefined) => boolean;
}

/**
 * Registers the realtime endpoint. Upgrades are rejected before the handshake
 * completes when the Origin is not allowed (CSWSH protection) or the client IP
 * already has too many open connections.
 */
export async function registerWebSocketServer(
  app: FastifyInstance,
  deps: WebSocketServerDeps,
): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: deps.config.maxMessageBytes,
      perMessageDeflate: false,
    },
  });

  app.get(
    deps.config.path,
    {
      websocket: true,
      config: { rateLimit: false },
      preValidation: async (request, reply) => {
        if (!deps.isOriginAllowed(request.headers.origin)) {
          await reply
            .code(403)
            .send({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed' } });
          return;
        }
        if (!deps.sessionManager.canAccept(request.ip)) {
          await reply.code(429).send({
            error: { code: 'TOO_MANY_CONNECTIONS', message: 'Too many open connections' },
          });
        }
      },
    },
    (socket, request) => deps.controller.handleConnection(socket, request),
  );

  // Transport heartbeat: terminate connections that stop answering pings (dead TCP).
  const heartbeat = setInterval(() => {
    deps.sessionManager.forEach((context) => {
      if (!context.client.isAlive) {
        context.client.terminate();
        return;
      }
      context.client.isAlive = false;
      context.client.ping();
    });
  }, deps.config.heartbeatIntervalMs);
  heartbeat.unref();
  app.addHook('onClose', async () => clearInterval(heartbeat));
}
