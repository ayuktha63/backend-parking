'use strict';

/**
 * Rate limiting.
 *
 * The previous system had none, which meant: unlimited OTP brute force, unlimited
 * WhatsApp sends against the operator's MSG91 quota, free enumeration of sequential
 * booking ids, and a trivial denial-of-service where one caller holds every slot in
 * a lot and re-holds it every 120 seconds at no cost.
 *
 * Falls back to a small in-process limiter if express-rate-limit is unavailable, so
 * the absence of a dependency can never silently mean "no limiting at all".
 *
 * NOTE: both the library and the fallback are per-process. A multi-instance
 * deployment needs a shared store (Redis) for these limits to be exact.
 */

const { config } = require('../config');
const { tooManyRequests } = require('../utils/errors');
const { logger } = require('../utils/logger');

let rateLimitLib = null;
try {
  // eslint-disable-next-line global-require
  rateLimitLib = require('express-rate-limit');
} catch {
  logger.warn('express-rate-limit not installed; using the in-process fallback limiter');
}

/** Identifies the caller: authenticated id when known, otherwise IP. */
function callerKey(req) {
  if (req.auth?.id) return `${req.auth.role}:${req.auth.id}`;
  // Trust proxy is configured on the app, so req.ip is the client address.
  return `ip:${req.ip}`;
}

/** Phone-scoped key for OTP endpoints, so one number cannot be attacked from many IPs. */
function phoneKey(req) {
  const phone = req.body?.phone;
  return phone ? `phone:${String(phone).slice(-10)}` : callerKey(req);
}

/** Minimal fixed-window limiter, used only when the library is missing. */
function fallbackLimiter({ windowMs, max, keyFn, code, message }) {
  const buckets = new Map();

  // Prevents unbounded growth from attacker-supplied keys.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 60_000));
  sweep.unref?.();

  return function limiter(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.ceil((entry.resetAt - now) / 1000));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return next(tooManyRequests(message, { retry_after_seconds: retryAfter }, code));
    }
    return next();
  };
}

function build({ windowMs, max, keyFn = callerKey, code = 'RATE_LIMITED', message }) {
  if (!config.rateLimit.enabled) {
    return (req, res, next) => next();
  }

  if (!rateLimitLib) {
    return fallbackLimiter({ windowMs, max, keyFn, code, message });
  }

  return rateLimitLib({
    windowMs,
    max,
    keyGenerator: keyFn,
    standardHeaders: true,
    legacyHeaders: false,
    // Delegate the response to the shared error handler so the body shape stays
    // identical to every other error in the API.
    handler: (req, res, next) => {
      const retryAfter = Math.ceil(windowMs / 1000);
      next(tooManyRequests(message, { retry_after_seconds: retryAfter }, code));
    },
  });
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const limiters = {
  /** Sending an OTP costs real money on the WhatsApp provider. Keyed by phone. */
  otpRequest: build({
    windowMs: HOUR,
    max: config.rateLimit.otpRequestPerHour,
    keyFn: phoneKey,
    code: 'OTP_REQUEST_RATE_LIMITED',
    message: 'Too many verification codes requested. Try again in an hour.',
  }),

  /** Guessing an OTP. Keyed by phone so attempts cannot be spread across IPs. */
  otpVerify: build({
    windowMs: HOUR,
    max: config.rateLimit.otpVerifyPerHour,
    keyFn: phoneKey,
    code: 'OTP_VERIFY_RATE_LIMITED',
    message: 'Too many attempts. Request a new code.',
  }),

  auth: build({
    windowMs: HOUR,
    max: config.rateLimit.authPerHour,
    code: 'AUTH_RATE_LIMITED',
    message: 'Too many sign-in attempts. Try again later.',
  }),

  /** Holds, bookings, cancellations. */
  write: build({
    windowMs: MINUTE,
    max: config.rateLimit.writePerMinute,
    code: 'WRITE_RATE_LIMITED',
    message: 'You are doing that too quickly. Please slow down.',
  }),

  read: build({
    windowMs: MINUTE,
    max: config.rateLimit.readPerMinute,
    code: 'READ_RATE_LIMITED',
    message: 'Too many requests. Please slow down.',
  }),

  /** Webhooks come from the payment provider; generous but not unbounded. */
  webhook: build({
    windowMs: MINUTE,
    max: 600,
    code: 'WEBHOOK_RATE_LIMITED',
    message: 'Too many webhook deliveries',
  }),
};

module.exports = { limiters, build, callerKey, phoneKey };
