'use strict';

/**
 * Structured logging with automatic PII redaction.
 *
 * Uses pino when available and falls back to a console shim so that the process
 * boots even before `npm install` has been run. The fallback keeps the same
 * interface, so no call site needs to know which is active.
 *
 * The previous implementation logged whole booking rows — phone numbers and vehicle
 * plates — to stdout on every verify call. Redaction here is not optional.
 */

const { config } = require('../config');

const REDACTED = '[redacted]';

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'otp',
  'otp_hash',
  'authorization',
  'cookie',
  'access_token',
  'refresh_token',
  'refresh_token_hash',
  'token',
  'signature',
  'razorpay_signature',
  'key_secret',
  'webhook_secret',
  'authkey',
  'auth_key',
  'connection_string',
  'database_url',
]);

/** Keys whose values are personally identifying and get partially masked. */
const PII_KEYS = new Set(['phone', 'number_plate', 'email']);

/** 9876543210 → "98•••••210" — enough to correlate a support ticket, not enough to harvest. */
function maskPhone(value) {
  const s = String(value ?? '');
  if (s.length < 6) return REDACTED;
  return `${s.slice(0, 2)}${'•'.repeat(Math.max(0, s.length - 5))}${s.slice(-3)}`;
}

function maskPlate(value) {
  const s = String(value ?? '');
  if (s.length < 4) return REDACTED;
  return `${'•'.repeat(s.length - 4)}${s.slice(-4)}`;
}

/** Recursively redacts a value for logging. Depth-limited to avoid cycles. */
function redact(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: value.stack };
  }
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    if (SENSITIVE_KEYS.has(key)) {
      out[k] = REDACTED;
    } else if (key === 'phone') {
      out[k] = maskPhone(v);
    } else if (key === 'number_plate' || key === 'plate') {
      out[k] = maskPlate(v);
    } else if (PII_KEYS.has(key)) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

const LEVELS = { silent: 100, error: 50, warn: 40, info: 30, debug: 20, trace: 10 };

function createFallbackLogger(bindings = {}) {
  const threshold = LEVELS[config.logging.level] ?? LEVELS.info;

  function emit(level, arg1, arg2) {
    if ((LEVELS[level] ?? 0) < threshold) return;
    const [payload, message] =
      typeof arg1 === 'string' ? [{}, arg1] : [redact(arg1 || {}), arg2 || ''];
    const line = {
      level,
      time: new Date().toISOString(),
      msg: message,
      ...redact(bindings),
      ...payload,
    };
    // This IS the console sink: the fallback logger used when pino is not
    // installed. Everywhere else in the codebase console is banned.
    // eslint-disable-next-line no-console
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    try {
      sink(JSON.stringify(line));
    } catch {
      sink(`${level} ${message}`);
    }
  }

  return {
    error: (a, b) => emit('error', a, b),
    warn: (a, b) => emit('warn', a, b),
    info: (a, b) => emit('info', a, b),
    debug: (a, b) => emit('debug', a, b),
    trace: (a, b) => emit('trace', a, b),
    child: (extra) => createFallbackLogger({ ...bindings, ...extra }),
  };
}

let logger;
try {
  // eslint-disable-next-line global-require
  const pino = require('pino');
  logger = pino({
    level: config.logging.level === 'silent' ? 'silent' : config.logging.level,
    redact: { paths: config.logging.redactPaths, censor: REDACTED },
    base: { service: 'parqx-api', env: config.env },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    hooks: {
      // Apply our own PII masking on top of pino's path-based redaction.
      logMethod(args, method) {
        if (args.length && typeof args[0] === 'object' && args[0] !== null) {
          args[0] = redact(args[0]);
        }
        return method.apply(this, args);
      },
    },
  });
} catch {
  logger = createFallbackLogger();
}

module.exports = { logger, redact, maskPhone, maskPlate, REDACTED };
