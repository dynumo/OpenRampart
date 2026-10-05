import { createServer } from 'node:http';
import path from 'node:path';
import { ConfigError, config } from './config.js';
import { closeDb, getPool } from './db/client.js';
import { runMigrations } from './db/migrator.js';
import { createApp } from './http/app.js';
import { startWorker } from './jobs/worker.js';
import { startQueue, stopQueue } from './jobs/queue.js';
import { logger } from './lib/logger.js';
import { ensureBucket } from './storage/s3.js';
import { toolVersion } from './ocr/engine.js';

/**
 * Process entry point. OPENRAMPART_ROLE selects what this process does:
 *   all     web server + background worker (default; simplest deployment)
 *   web     web server only (API, UI, OAuth, MCP)
 *   worker  background jobs only (OCR, previews, timestamps, maintenance)
 */
async function main() {
  let c;
  try {
    c = config();
  } catch (err) {
    if (err instanceof ConfigError) {
      // The logger is not configured yet; configuration problems go straight to stderr.
      // eslint-disable-next-line no-console
      console.error(err.message);
      process.exit(78);
    }
    throw err;
  }
  logger.info({ role: c.OPENRAMPART_ROLE, appUrl: c.APP_URL }, 'starting OpenRampart');

  await getPool()
    .query('SELECT 1')
    .catch((err: Error) => {
      throw new Error(`Cannot connect to PostgreSQL (DATABASE_URL): ${err.message}`);
    });
  if (process.env.OPENRAMPART_SKIP_MIGRATIONS !== 'true') {
    const result = await runMigrations(getPool());
    if (result.applied.length)
      logger.info({ applied: result.applied }, 'database migrations applied');
  }
  await ensureBucket();

  if (c.OCR_ENABLED && c.OPENRAMPART_ROLE !== 'web') {
    const [tesseract, ocrmypdf] = await Promise.all([
      toolVersion('tesseract'),
      toolVersion('ocrmypdf'),
    ]);
    if (!tesseract)
      logger.warn(
        'tesseract was not found: image OCR will fail. Install tesseract-ocr or set OCR_ENABLED=false.',
      );
    if (!ocrmypdf) logger.warn('ocrmypdf was not found: scanned PDF OCR will fail.');
  }

  if (c.OPENRAMPART_ROLE !== 'web') await startWorker();
  else await startQueue({ supervise: false });

  let server: ReturnType<typeof createServer> | undefined;
  if (c.OPENRAMPART_ROLE !== 'worker') {
    let devMiddleware;
    if (c.NODE_ENV === 'development') {
      const { createServer: createVite } = await import('vite');
      const vite = await createVite({
        server: { middlewareMode: true },
        appType: 'spa',
        root: process.cwd(),
      });
      devMiddleware = vite.middlewares;
    }
    const app = createApp({ devMiddleware, webRoot: path.resolve(process.cwd(), 'dist/web') });
    server = createServer(app);
    server.requestTimeout = 15 * 60_000; // large uploads and exports on slow connections
    server.headersTimeout = 60_000;
    await new Promise<void>((resolve) => server!.listen(c.PORT, c.HOST, resolve));
    logger.info({ port: c.PORT }, 'web server listening');
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 25_000);
    timer.unref();
    if (server) await new Promise((r) => server!.close(r));
    await stopQueue().catch(() => undefined);
    await closeDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, 'OpenRampart failed to start');
  // eslint-disable-next-line no-console
  console.error((err as Error).message);
  process.exit(1);
});
