import { existsSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { getPool } from '../db/client.js';
import { loggablePath, logger } from '../lib/logger.js';
import { storageHealthy } from '../storage/s3.js';
import {
  csrfProtection,
  errorHandler,
  loadSession,
  recordContext,
  requestRateLimit,
  requireUser,
} from './middleware.js';
import { authRouter, invitationRouter } from './routes/auth.js';
import {
  authorizationServerMetadata,
  interactionRouter,
  mcpEndpoint,
  oauthProvider,
  protectedResourceMetadata,
} from './routes/oauth.js';
import { recordRouter } from './routes/record.js';
import { settingsRouter } from './routes/settings.js';
import { INTERACTION_PATH } from '../oauth/provider.js';
import { ValidationError } from '../lib/errors.js';

export interface AppOptions {
  /** Directory of the built web UI (production). */
  webRoot?: string;
  /** Vite dev middleware (development). */
  devMiddleware?: express.RequestHandler;
}

export function createApp(opts: AppOptions = {}): Express {
  const c = config();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', c.trustProxy);
  app.set('query parser', 'extended');

  app.use(
    pinoHttp({
      logger,
      // Never log query strings or one-time tokens in paths: they can contain secrets or search text.
      serializers: {
        req: (req: { method: string; url: string; id: unknown }) => ({
          id: req.id,
          method: req.method,
          path: loggablePath(req.url),
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
    }),
  );

  const dev = c.NODE_ENV === 'development';
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
          'style-src': ["'self'"],
          'style-src-attr': ["'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'media-src': ["'self'", 'blob:'],
          'font-src': ["'self'"],
          'connect-src': dev ? ["'self'", 'ws:'] : ["'self'"],
          'frame-src': ["'self'"],
          'worker-src': ["'self'"],
          'manifest-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          ...(c.cookieSecure ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: c.cookieSecure
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
    }),
  );
  app.use((_req, res, next) => {
    res.set(
      'Permissions-Policy',
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    );
    next();
  });

  app.use(requestRateLimit);

  // --- health
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    const [dbOk, s3Ok] = await Promise.all([
      getPool()
        .query('SELECT 1')
        .then(() => true)
        .catch(() => false),
      storageHealthy(),
    ]);
    res
      .status(dbOk && s3Ok ? 200 : 503)
      .json({ database: dbOk ? 'ok' : 'unavailable', storage: s3Ok ? 'ok' : 'unavailable' });
  });

  // --- OAuth / MCP discovery (before body parsing; the provider parses its own bodies)
  app.get(
    ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/*rest'],
    protectedResourceMetadata,
  );
  app.get(
    ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'],
    authorizationServerMetadata,
  );
  app.all('/mcp', mcpEndpoint);

  app.use(cookieParser());
  app.use(loadSession);

  // Consent screen API (cookie-scoped to the interaction path) before the provider mount.
  app.use(INTERACTION_PATH, express.json({ limit: '64kb' }), interactionRouter());
  app.use('/oauth', (req, res, next) => {
    // GET /oauth/interaction/:uid is the consent page itself (served by the web UI).
    if (req.method === 'GET' && /^\/interaction\/[A-Za-z0-9_-]+\/?$/.test(req.path)) return next();
    return oauthProvider(req, res, next);
  });

  // --- JSON API
  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(csrfProtection);
  api.use('/auth', authRouter());
  api.use('/invitations', invitationRouter());
  api.use('/settings', requireUser, settingsRouter());
  api.use(requireUser, recordContext, recordRouter());
  api.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });
  app.use('/api', api);

  // --- web UI
  if (opts.devMiddleware) {
    app.use(opts.devMiddleware);
  } else {
    const root = opts.webRoot ?? path.resolve(process.cwd(), 'dist/web');
    if (existsSync(root)) {
      app.use(
        express.static(root, {
          index: false,
          setHeaders: (res, filePath) => {
            if (filePath.includes(`${path.sep}assets${path.sep}`))
              res.set('Cache-Control', 'public, max-age=31536000, immutable');
            else res.set('Cache-Control', 'no-cache');
          },
        }),
      );
      app.get(['/', '/*splat'], (req, res, next) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/.well-known/')) return next();
        res.set('Cache-Control', 'no-cache');
        res.sendFile(path.join(root, 'index.html'));
      });
    } else {
      logger.warn({ root }, 'web UI build not found; run "npm run build:web"');
    }
  }

  app.use(
    (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof ZodError) {
        const fields: Record<string, string> = {};
        for (const i of err.issues) fields[i.path.join('.') || 'input'] = i.message;
        return errorHandler(
          new ValidationError('Please check the details entered', fields),
          req,
          res,
          next,
        );
      }
      return errorHandler(err, req, res, next);
    },
  );
  return app;
}
