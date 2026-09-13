'use strict';

/**
 * Express application assembly.
 *
 * Deliberately separate from server.js so tests can mount the app without opening a
 * port or starting background jobs.
 *
 * Middleware order matters and is the security posture of the service:
 *   1. trust proxy      so req.ip is the real client, not the load balancer
 *   2. helmet           baseline headers
 *   3. request context  id + scoped logger, before anything can fail
 *   4. cors             explicit allow-list (the previous system used origin:'*')
 *   5. body parsing     size-limited; raw body retained for webhook signatures
 *   6. routes
 *   7. 404, then the error handler — the only place that decides what a client sees
 */

const path = require('node:path');

const express = require('express');
const cors = require('cors');

const { config } = require('./config');
const { logger } = require('./utils/logger');
const { requestContext } = require('./middleware/requestContext');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const v1Routes = require('./routes/v1');

function buildCorsOptions() {
  const origins = config.server.corsOrigins;

  // '*' is rejected by config validation in production; allowed elsewhere so that
  // `flutter run -d chrome` and curl work without ceremony.
  if (origins.includes('*')) {
    return { origin: true, credentials: false };
  }

  return {
    origin(origin, callback) {
      // Same-origin requests and native mobile clients send no Origin header.
      if (!origin) return callback(null, true);
      if (origins.includes(origin)) return callback(null, true);
      logger.warn({ origin }, 'Blocked by CORS');
      return callback(null, false);
    },
    credentials: true,
    maxAge: 86400,
  };
}

function createApp() {
  const app = express();

  app.set('trust proxy', config.server.trustProxy);
  app.disable('x-powered-by');

  // helmet is optional at runtime so a missing dependency cannot stop boot.
  try {
    // eslint-disable-next-line global-require
    const helmet = require('helmet');
    app.use(
      helmet({
        // The API serves JSON to native clients; CSP here would only add noise.
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
      })
    );
  } catch {
    logger.warn('helmet not installed; security headers are not being set');
  }

  app.use(requestContext);
  app.use(cors(buildCorsOptions()));

  app.use(
    express.json({
      limit: '256kb',
      // Payment webhooks are signed over the exact bytes received, so the raw body
      // must be preserved before JSON parsing rewrites it.
      verify(req, res, buf) {
        if (req.originalUrl.includes('/payments/webhook')) {
          req.rawBody = Buffer.from(buf);
        }
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  /* ── routes ──────────────────────────────────────────────────────────────── */

  // Unversioned liveness probe for the platform's health check.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'parqx-api', env: config.env });
  });

  app.get('/', (req, res) => {
    res.json({
      data: {
        service: 'PARQX API',
        versions: ['v1'],
        docs: '/api/v1/meta',
      },
    });
  });

  /**
   * Uploaded parking photographs.
   *
   * Served before the API routes and outside `/api`, because these are files,
   * not resources — a CDN or object store would front this path in production
   * and the application would never see the request at all.
   *
   * `immutable` is safe because filenames are UUIDs: a given URL's bytes never
   * change, and replacing a photo produces a new URL.
   */
  app.use(
    '/uploads',
    express.static(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'), {
      maxAge: '30d',
      immutable: true,
      index: false,
      dotfiles: 'deny',
      fallthrough: false,
    })
  );

  app.use('/api/v1', v1Routes);

  /**
   * Legacy /api/* routes.
   *
   * Already-shipped app builds point at these paths and cannot be updated
   * retroactively, so they stay mounted, log their usage, and are removed only once
   * that telemetry reaches zero — a date-independent, evidence-based cutover.
   */
  if (config.features.legacyRoutesEnabled) {
    // eslint-disable-next-line global-require
    const legacyRoutes = require('./routes/legacy');
    app.use('/api', legacyRoutes);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
