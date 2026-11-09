import { buildApp } from './app';
import { loadEnv, loadEnvFiles } from './config/env.config';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const envFile = loadEnvFiles();
  const env = loadEnv();
  const { app, container } = await buildApp({ env });

  if (envFile) app.log.info({ envFile }, 'Loaded environment file');
  app.log.info(
    {
      demo: container.providers.describe('demo'),
      live: {
        ...container.providers.availability('live'),
        ...container.providers.describe('live'),
      },
    },
    'Providers configured',
  );

  await app.listen({ host: env.HOST, port: env.PORT });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down gracefully');
    const forceExit = setTimeout(() => {
      app.log.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Unhandled promise rejection');
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
