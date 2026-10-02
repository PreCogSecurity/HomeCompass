/**
 * HomeCompass process entrypoint.
 *
 * Boot order matters: configuration is validated, then the database is loaded
 * (refusing to start on corruption), and only then is the port opened. Shutdown
 * is graceful so an in-flight write finishes before the process exits.
 */
import { createApp } from './app.js';
import { createConfig, loadEnvFile } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { InventoryStore } from './lib/store.js';

async function main() {
  loadEnvFile();
  const config = createConfig(process.env);
  const logger = createLogger({ level: config.logLevel });

  const store = new InventoryStore({ file: config.storeFile, maxItems: config.maxItems, logger });
  await store.init();
  logger.info('Inventory loaded', { records: store.count, store: store.file });

  const app = createApp({ config, store, logger, publicDir: config.publicDir });

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, config.host, () => {
      app.server.removeListener('error', reject);
      resolve();
    });
  });

  const address = app.server.address();
  logger.info('HomeCompass listening', {
    host: config.host,
    port: typeof address === 'object' && address !== null ? address.port : config.port,
    env: config.env,
    trustProxy: config.trustProxy,
  });
  if (config.env !== 'production') {
    logger.info('Open http://%s:%s in your browser', { host: config.host });
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    app.server.close((error) => {
      clearTimeout(forceExit);
      if (error) {
        logger.error('Error closing HTTP server', { error });
        process.exit(1);
      }
      logger.info('Shutdown complete');
      process.exit(0);
    });
    // Nudge idle keep-alive sockets so close() can resolve promptly.
    app.server.closeIdleConnections();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: reason });
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  const logger = createLogger({ level: 'error' });
  logger.error('HomeCompass failed to start', { error });
  process.exitCode = 1;
});
