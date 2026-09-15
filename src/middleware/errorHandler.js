'use strict';

/**
 * Error handling and 404s.
 *
 * One rule: a client only ever sees a message that was deliberately written for it.
 * The previous implementation returned `String(err)` and `err.message` directly,
 * which leaked Postgres table names, column names and constraint names on every
 * failed query.
 *
 * Response shape (consistent across every endpoint):
 *   { "error": { "code", "message", "details"?, "request_id" } }
 */

const { AppError, PG } = require('../utils/errors');
const { config } = require('../config');

function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route matches ${req.method} ${req.path}`,
      request_id: req.id,
    },
  });
}

/**
 * Translates a raw Postgres error into something safe and useful.
 * Returns null when there is no sensible translation.
 */
function translatePgError(err) {
  if (!err || !err.code) return null;

  switch (err.code) {
    case PG.UNIQUE_VIOLATION:
      // Constraint names are chosen to be meaningful, but are never echoed.
      if (String(err.constraint || '').includes('booking_code')) {
        return { status: 409, code: 'DUPLICATE_BOOKING_CODE', message: 'Please try again' };
      }
      if (String(err.constraint || '').includes('slot_holds_one_active')) {
        return {
          status: 409,
          code: 'SLOT_HELD_BY_ANOTHER',
          message: 'Someone else is holding this slot right now',
        };
      }
      return {
        status: 409,
        code: 'ALREADY_EXISTS',
        message: 'That already exists',
      };

    case PG.FOREIGN_KEY_VIOLATION:
      return {
        status: 409,
        code: 'RELATED_RECORD_MISSING',
        message: 'A related record is missing or still in use',
      };

    case PG.CHECK_VIOLATION:
      return {
        status: 422,
        code: 'VALUE_NOT_ALLOWED',
        message: 'One of the values provided is not allowed',
      };

    case PG.NOT_NULL_VIOLATION:
      return { status: 422, code: 'FIELD_REQUIRED', message: 'A required field was missing' };

    // 23P01 — the no-overlap exclusion constraint on bookings. This is the
    // storage layer refusing a double booking.
    case '23P01':
      return {
        status: 409,
        code: 'SLOT_UNAVAILABLE',
        message: 'That slot was just taken for the time you selected',
      };

    case PG.SERIALIZATION_FAILURE:
    case PG.DEADLOCK_DETECTED:
      return {
        status: 409,
        code: 'CONCURRENT_UPDATE',
        message: 'Too many people are booking at once. Please try again.',
      };

    case PG.QUERY_CANCELED:
      return {
        status: 503,
        code: 'QUERY_TIMEOUT',
        message: 'That took too long. Please try again.',
      };

    default:
      return null;
  }
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
function errorHandler(err, req, res, next) {
  const log = req.log || console;

  // 1. Deliberate application errors — safe to expose.
  if (err instanceof AppError || (err && err.expose === true && err.status)) {
    if (err.status >= 500) {
      log.error({ err, code: err.code }, 'Application error');
    } else {
      log.warn({ code: err.code, status: err.status, details: err.details }, err.message);
    }

    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
        request_id: req.id,
      },
    });
  }

  // 2. Malformed JSON from express.json().
  if (err && err.type === 'entity.parse.failed') {
    log.warn('Malformed JSON body');
    return res.status(400).json({
      error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON', request_id: req.id },
    });
  }

  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', request_id: req.id },
    });
  }

  // 3. Known database failures.
  const translated = translatePgError(err);
  if (translated) {
    log.warn({ pgCode: err.code, constraint: err.constraint }, 'Database constraint hit');
    return res.status(translated.status).json({
      error: { code: translated.code, message: translated.message, request_id: req.id },
    });
  }

  // 4. Everything else: log fully, tell the client nothing.
  log.error({ err }, 'Unhandled error');

  const body = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Please try again.',
      request_id: req.id,
    },
  };

  // Outside production, include the real error to keep debugging fast.
  if (!config.isProduction) {
    body.error.debug = { name: err?.name, message: err?.message, code: err?.code };
  }

  return res.status(500).json(body);
}

module.exports = { errorHandler, notFoundHandler, translatePgError };
