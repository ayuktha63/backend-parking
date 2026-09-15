'use strict';

/**
 * PARQX API — process bootstrap.
 *
 * Deliberately thin. It validates configuration, checks the database, starts the
 * HTTP and socket servers, and shuts them down cleanly. Everything else lives in
 * src/ — the previous version of this file was 1,672 lines containing the entire
 * system.
 *
 * The original is preserved at legacy/server.legacy.js and its routes are mounted
 * as an adapter at /api so that already-shipped app builds keep working.
 */

// Load .env before anything reads config. Uses Node's built-in support when
// available (>= 20.6) and falls back to a tiny parser, so there is no dependency
// on dotenv just to boot.
loadEnvFile();

const http = require('http');
const { config, validate } = require('./src/config');
const { logger } = require('./src/utils/logger');
const db = require('./src/db');
const gateway = require('./src/sockets/gateway');
const jobs = require('./src/jobs');
const { createApp } = require('./src/app');

async function main() {
  /* ── 1. configuration ────────────────────────────────────────────────────── */

  const problems = validate();
  if (problems.length > 0) {
    for (const p of problems) logger.error({ problem: p }, 'Configuration problem');

    if (config.isProduction) {
      logger.error('Refusing to start in production with an invalid configuration');
      process.exit(1);
    }
    logger.warn(
      { count: problems.length },
      'Starting with configuration problems (non-production only)'
    );
  }

  /* ── 2. database ─────────────────────────────────────────────────────────── */

  try {
    await db.healthCheck();
    logger.info('Database connection established');
  } catch (err) {
    logger.error(
      { err },
      'Cannot reach the database. Set DATABASE_URL in .env and run `npm run migrate`.'
    );
    process.exit(1);
  }

  await warnOnPendingMigrations();

  /* ── 3. servers ──────────────────────────────────────────────────────────── */

  const app = createApp();
  const server = http.createServer(app);

  gateway.attach(server);
  jobs.start();

  server.listen(config.server.port, config.server.host, () => {
    logger.info(
      {
        port: config.server.port,
        host: config.server.host,
        env: config.env,
        legacyRoutes: config.features.legacyRoutesEnabled,
        authRequired: config.features.authRequired,
        paymentVerification: config.features.serverPaymentVerification,
      },
      `PARQX API listening on http://${config.server.host}:${config.server.port}`
    );
  });

  /* ── 4. shutdown ─────────────────────────────────────────────────────────── */

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out; exiting');
      process.exit(1);
    }, config.server.shutdownGraceMs);
    force.unref();

    try {
      // Stop accepting work first, then drain.
      await new Promise((resolve) => server.close(resolve));
      await gateway.close();
      await jobs.stop();

      // Flush buffered deprecation telemetry so a redeploy does not lose the signal
      // that gates the legacy cutover.
      try {
        // eslint-disable-next-line global-require
        await require('./src/routes/legacy').flushUsage();
      } catch {
        /* table may not exist yet */
      }

      await db.close();
      clearTimeout(force);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception — shutting down');
    shutdown('uncaughtException');
  });
}

/**
 * Warns when the schema is behind the code. Does not apply migrations on boot:
 * a process restart must never silently alter a production schema.
 */
async function warnOnPendingMigrations() {
  try {
    // eslint-disable-next-line global-require
    const { status } = require('./src/db/migrate');
    const rows = await status();
    const pending = rows.filter((r) => !r.applied);
    const drifted = rows.filter((r) => r.drifted);

    if (drifted.length) {
      logger.error(
        { files: drifted.map((d) => d.file) },
        'Applied migrations have been modified. The schema may not match the code.'
      );
    }
    if (pending.length) {
      logger.warn(
        { files: pending.map((p) => p.file) },
        'Pending migrations. Run `npm run migrate`.'
      );
    }
  } catch (err) {
    logger.debug({ err }, 'Could not check migration status');
  }
}

/** Minimal .env loader: no dependency, no overwriting of real environment values. */
function loadEnvFile() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');

  if (!fs.existsSync(envPath)) return;

  // Node >= 20.6 can do this natively and handles quoting edge cases properly.
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
      return;
    } catch {
      /* fall through to the manual parser */
    }
  }

  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // A real environment variable always wins over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
