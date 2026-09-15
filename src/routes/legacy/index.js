'use strict';

/**
 * Legacy /api/* surface.
 *
 * Mounted so that app builds already installed on users' phones keep working. Three
 * things happen here, in order:
 *
 *   1. Every call is counted in `deprecated_endpoint_usage`. Migration 0008 refuses
 *      to run while that table shows recent traffic, which makes the cutover
 *      evidence-based rather than date-based.
 *
 *   2. A small number of endpoints are OVERRIDDEN rather than preserved. Preserving
 *      them would mean preserving silent data loss, an authentication bypass, and an
 *      endpoint that hands out one-time passcodes in its own response body. An
 *      endpoint that is dangerous is not "working behaviour" worth keeping.
 *
 *   3. Everything else falls through to the original implementation, unchanged.
 */

const express = require('express');
const db = require('../../db');
const { logger } = require('../../utils/logger');
const { config } = require('../../config');

const router = express.Router();

/* ── 1. usage telemetry ────────────────────────────────────────────────────── */

/**
 * Records a hit. Fire-and-forget: instrumentation must never fail a user request.
 * Buffered in memory and flushed periodically so a burst of traffic does not turn
 * into a write per request.
 */
const usageBuffer = new Map();

function recordUsage(req) {
  // Route path, not the concrete URL, so ids do not explode the cardinality.
  //
  // `req.route.path` is an ARRAY when a handler was registered for several paths
  // — as the retired OTP endpoints are. Storing it raw wrote the Postgres array
  // literal {"/auth/send-otp","/auth/verify-otp"} as a single endpoint name, so
  // the telemetry that GATES migration 0008 could not attribute a call to either
  // route. Resolve to the path actually requested.
  const routePath = req.route?.path;
  const endpoint = Array.isArray(routePath)
    ? routePath.find((candidate) => candidate === req.path) || req.path
    : routePath || req.path.replace(/\/\d+/g, '/:id');
  const client = req.get('user-agent')?.slice(0, 60) || 'unknown';
  const key = `${req.method} ${endpoint} ${client}`;

  // The parts are stored alongside the count rather than re-parsed out of the key.
  // A User-Agent contains spaces, so splitting a composite key on a delimiter is
  // fragile whatever the delimiter is.
  const existing = usageBuffer.get(key);
  if (existing) {
    existing.hits += 1;
  } else {
    usageBuffer.set(key, { method: req.method, endpoint, client, hits: 1 });
  }
}

async function flushUsage() {
  if (usageBuffer.size === 0) return;
  const entries = [...usageBuffer.values()];
  usageBuffer.clear();

  for (const { method, endpoint, client, hits } of entries) {
    try {
      await db.query(
        `INSERT INTO deprecated_endpoint_usage (endpoint, method, client_label, hits)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint, method, client_label)
         DO UPDATE SET hits = deprecated_endpoint_usage.hits + EXCLUDED.hits,
                       last_seen_at = NOW()`,
        [endpoint, method, client, hits]
      );
    } catch (err) {
      // The table only exists after migration 0008; absence is not an error.
      logger.debug({ err }, 'Deprecated-usage flush skipped');
    }
  }
}

const flushTimer = setInterval(flushUsage, 60_000);
flushTimer.unref?.();

router.use((req, res, next) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</api/v1>; rel="successor-version"');

  res.on('finish', () => {
    // Only count calls a legacy route actually handled. A request that fell
    // through to the 404 handler is not legacy traffic, and counting it kept
    // `deprecated_endpoint_usage` permanently non-empty — which would block
    // migration 0008 forever, since 0008 refuses to run while the table shows
    // recent traffic.
    if (res.statusCode === 404 && !req.route) return;
    recordUsage(req);
  });

  next();
});

/* ── 2. overrides ──────────────────────────────────────────────────────────── */

/**
 * The OTP endpoints returned the generated code in their own response as
 * `debug_otp`, which defeats the entire mechanism — anyone able to call the
 * endpoint for a phone number learned that number's code without seeing the message.
 *
 * Verified by inspection: neither shipped app ever called these, so disabling them
 * breaks nothing. Real OTP lives at /api/v1/auth/otp/*.
 */
router.post(['/auth/send-otp', '/auth/verify-otp'], (req, res) => {
  logger.warn({ path: req.path }, 'Blocked call to a retired legacy OTP endpoint');
  res.status(410).json({
    error: {
      code: 'ENDPOINT_RETIRED',
      message: 'This endpoint has been retired. Use /api/v1/auth/otp/request.',
      request_id: req.id,
    },
  });
});

/**
 * `POST /api/owner/login` accepted a request with no password and returned the
 * account, and the operator app's own profile screen depended on that. The password
 * path is kept; the bypass is not.
 */
router.post('/owner/login', express.json(), async (req, res, next) => {
  const { phone, password } = req.body || {};

  if (!phone) {
    return res.status(400).json({ message: 'phone is required' });
  }

  if (!password) {
    logger.warn('Blocked password-less legacy owner login');
    // Legacy error shape, because shipped clients parse `message`.
    return res.status(400).json({ message: 'Password is required' });
  }

  // Delegate to the hardened implementation, then reshape to the legacy response.
  try {
    // eslint-disable-next-line global-require
    const authService = require('../../services/authService');
    // eslint-disable-next-line global-require
    const { normalisePhone } = require('../../validators/common');
    // eslint-disable-next-line global-require
    const ownerRepository = require('../../repositories/ownerRepository');

    const normalised = normalisePhone(phone);
    await authService.ownerPasswordLogin({ phone: normalised, password });

    const owner = await ownerRepository.findByPhone(normalised);
    const area = await ownerRepository.primaryParkingArea(owner.id);

    return res.status(200).json({
      message: 'Login successful',
      phone: owner.phone,
      parking_area_name: area?.name ?? owner.name ?? null,
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }
    return next(err);
  }
});

/**
 * `POST /api/owner/parking_areas` located a lot by name — not by owner — and, when
 * the capacity changed, ran:
 *     DELETE FROM slots    WHERE parking_id = $1
 *     DELETE FROM bookings WHERE parking_id = $1
 * with no archival, no transaction and no socket broadcast. Any anonymous caller who
 * knew a lot's name could destroy every booking in it.
 *
 * Capacity changes now require an authenticated operator and go through the safe
 * workflow at PUT /api/v1/owner/parking/:id. Location-only edits are still accepted
 * here so an operator on an old build is not locked out of their own lot.
 */
router.post('/owner/parking_areas', express.json(), async (req, res, next) => {
  const { name: ownerPhone, parking_area_name, location, total_car_slots, total_bike_slots } =
    req.body || {};

  if (!ownerPhone) return res.status(400).json({ message: 'owner phone (name) is required' });
  if (!parking_area_name) return res.status(400).json({ message: 'parking_area_name is required' });

  try {
    const existing = await db.queryOne(
      'SELECT id, total_car_slots, total_bike_slots FROM parking_areas WHERE name = $1 LIMIT 1',
      [parking_area_name]
    );

    if (!existing) {
      return res.status(400).json({
        message:
          'Creating a parking area now requires a signed-in operator account. Please update the app.',
      });
    }

    const carChanged =
      typeof total_car_slots === 'number' && total_car_slots !== existing.total_car_slots;
    const bikeChanged =
      typeof total_bike_slots === 'number' && total_bike_slots !== existing.total_bike_slots;

    if (carChanged || bikeChanged) {
      logger.warn(
        { parkingAreaId: existing.id },
        'Blocked destructive legacy capacity change'
      );
      return res.status(409).json({
        message:
          'Changing slot capacity now requires a signed-in operator account, because it affects existing bookings. Please update the app.',
      });
    }

    // Non-destructive: coordinates only.
    await db.query(
      `UPDATE parking_areas
          SET lat = COALESCE($1, lat), lng = COALESCE($2, lng), updated_at = NOW()
        WHERE id = $3`,
      [location?.lat ?? null, location?.lng ?? null, existing.id]
    );

    return res.status(200).json({ message: 'Parking area updated successfully' });
  } catch (err) {
    return next(err);
  }
});

/**
 * Booking and payment endpoints are RETIRED, not preserved.
 *
 * `POST /bookings` confirmed a booking for any non-empty `payment_id` — no order, no
 * signature, no authentication — so before migration 0008 anyone could book for
 * free. `/bookings/cancel` and `/owner/bookings/complete` ended in
 * `DELETE FROM bookings`. On a schema past 0008 every one of them fails before it
 * writes (renamed columns, the read-only booking_history), answering with a 500
 * that echoes the SQL error. Nothing here still worked; what remained was a second,
 * unsafe booking system beside /api/v1, which is now the only one.
 *
 * Old app builds reach these after taking a payment client-side. A clear 410 is the
 * honest answer; the fix for those customers is the gateway dashboard (orders
 * required) and an app update, not accepting an unverified payment id.
 */
const RETIRED_BOOKING_ROUTES = [
  ['post', '/bookings'],
  ['post', '/owner/bookings'],
  ['post', '/bookings/verify'],
  ['post', '/owner/bookings/verify'],
  ['post', '/bookings/cancel'],
  ['post', '/owner/bookings/complete'],
  ['post', '/holds'],
  ['delete', '/holds'],
];

for (const [method, path] of RETIRED_BOOKING_ROUTES) {
  router[method](path, (req, res) => {
    logger.warn({ path: req.path, method: req.method }, 'Blocked call to a retired legacy booking endpoint');
    // Legacy error shape, because shipped clients parse `message`.
    res.status(410).json({
      message: 'This version of PARQX can no longer make or change bookings. Please update the app.',
      code: 'ENDPOINT_RETIRED',
    });
  });
}

/* ── 3. the preserved original ─────────────────────────────────────────────── */

// eslint-disable-next-line global-require
router.use(require('./legacyRouter'));

/**
 * The dev reset endpoint is gated by config rather than the original's env read, so
 * it cannot be enabled in production.
 */
if (!config.features.devReset) {
  router.post('/dev/reset-active-state', (req, res) => {
    res.status(403).json({ message: 'Dev reset endpoint is disabled' });
  });
}

module.exports = router;
module.exports.flushUsage = flushUsage;
