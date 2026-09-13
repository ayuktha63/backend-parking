'use strict';

/**
 * /api/v1 router.
 *
 * Feature routers are mounted here as each phase lands. Anything not yet built
 * returns a deliberate 501 rather than a confusing 404, so a client integrating
 * early can tell "not implemented yet" from "wrong URL".
 */

const express = require('express');
const { config } = require('../../config');
const db = require('../../db');
const paymentService = require('../../services/paymentService');

const authRoutes = require('./auth');
const meRoutes = require('./me');
const parkingRoutes = require('./parking');
const holdRoutes = require('./holds');
const bookingRoutes = require('./bookings');
const paymentRoutes = require('./payments');
const ownerRoutes = require('./owner');

const router = express.Router();

/* ── service metadata ──────────────────────────────────────────────────────── */

router.get('/health', async (req, res) => {
  try {
    const dbHealth = await db.healthCheck();
    res.json({
      data: {
        status: 'ok',
        env: config.env,
        time: new Date().toISOString(),
        database: { ok: true, server_time: dbHealth.now },
      },
    });
  } catch {
    res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Database is unreachable',
        request_id: req.id,
      },
    });
  }
});

/** Lets clients discover which capabilities this deployment actually has enabled. */
router.get('/meta', (req, res) => {
  res.json({
    data: {
      api_version: 'v1',
      currency: config.payments.currency,
      booking: {
        hold_seconds: config.booking.holdSeconds,
        hold_extension_seconds: config.booking.holdExtensionSeconds,
        max_hold_extensions: config.booking.maxHoldExtensions,
        pending_payment_seconds: config.booking.pendingPaymentSeconds,
        min_duration_minutes: config.booking.minDurationMinutes,
        max_duration_minutes: config.booking.maxDurationMinutes,
        default_duration_minutes: config.booking.defaultDurationMinutes,
        max_advance_days: config.booking.maxAdvanceDays,
        check_in_early_minutes: config.booking.checkInEarlyMinutes,
        check_in_late_minutes: config.booking.checkInLateMinutes,
        max_active_per_user: config.booking.maxActivePerUser,
      },

      // Stated plainly so the app can disable the Pay button with an honest
      // message rather than opening a checkout that cannot complete.
      cancellation: {
        slabs: config.refunds.slabs.map((s) => ({
          min_minutes_before: s.minMinutesBefore,
          refund_percent: s.percent,
        })),
      },
      features: {
        refunds_enabled: config.features.refundsEnabled,
        server_payment_verification: config.features.serverPaymentVerification,
        // False when no gateway credentials are configured. The client shows
        // "payments unavailable" instead of a button that leads nowhere.
        payments_available: paymentService.isConfigured(),
      },
      payments: {
        provider: config.payments.provider,
        // The key id is public by design; the secret never leaves the server.
        key_id: config.payments.razorpay.keyId || null,
      },
    },
  });
});

/* ── feature routers ───────────────────────────────────────────────────────── */

router.use('/auth', authRoutes);
router.use('/me', meRoutes);
router.use('/parking', parkingRoutes);
router.use('/holds', holdRoutes);
router.use('/bookings', bookingRoutes);
router.use('/payments', paymentRoutes);
router.use('/owner', ownerRoutes);

module.exports = router;
