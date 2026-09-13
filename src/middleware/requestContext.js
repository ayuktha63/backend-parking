'use strict';

/**
 * Assigns every request a stable id and a scoped logger.
 *
 * The id is echoed back in the `X-Request-Id` header and inside every error body,
 * so a user reporting "it failed" can be traced to exact log lines. The previous
 * implementation had no correlation of any kind — incidents were diagnosed by
 * reading emoji console.log statements.
 */

const crypto = require('crypto');
const { logger } = require('../utils/logger');

const HEADER = 'x-request-id';

function requestContext(req, res, next) {
  const incoming = req.get(HEADER);
  // Accept a client-supplied id only if it looks safe to echo into logs and headers.
  const id =
    incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);

  req.log = logger.child({
    requestId: id,
    method: req.method,
    path: req.path,
  });

  req.startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    req.log[level](
      {
        status: res.statusCode,
        durationMs: Math.round(durationMs),
        // Present once auth middleware has run.
        actor: req.auth ? `${req.auth.role}:${req.auth.id}` : 'anonymous',
      },
      'request completed'
    );
  });

  next();
}

module.exports = { requestContext, REQUEST_ID_HEADER: HEADER };
