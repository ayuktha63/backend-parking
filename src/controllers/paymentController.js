'use strict';

/**
 * Payment HTTP layer.
 *
 * The webhook route is the only endpoint in the system that is not authenticated by
 * a token — it is authenticated by an HMAC over the request body instead, which is
 * stronger for this purpose because it also proves the body was not altered.
 */

const paymentService = require('../services/paymentService');
const { asyncHandler } = require('./authController');
const { logger } = require('../utils/logger');

/** POST /api/v1/payments/order */
const createOrder = asyncHandler(async (req, res) => {
  const order = await paymentService.createOrderForBooking({
    userId: req.auth.id,
    bookingId: req.body.booking_id,
    idempotencyKey: req.body.idempotency_key ?? null,
  });
  res.status(201).json({ data: order });
});

/**
 * POST /api/v1/payments/verify
 *
 * The device reports what Checkout returned. This endpoint decides whether it is
 * true. A 200 here means the signature verified and the booking is CONFIRMED.
 */
const verify = asyncHandler(async (req, res) => {
  const result = await paymentService.verifyClientCallback({
    userId: req.auth.id,
    bookingId: req.body.booking_id,
    providerOrderId: req.body.razorpay_order_id,
    providerPaymentId: req.body.razorpay_payment_id,
    signature: req.body.razorpay_signature,
  });

  res.json({
    data: result.booking,
    meta: { verified: result.verified, already_settled: result.already_settled },
  });
});

/**
 * POST /api/v1/payments/failed
 *
 * The customer dismissed Checkout or the card was declined. Recorded, not punished:
 * the booking stays payable until its window closes.
 */
const failed = asyncHandler(async (req, res) => {
  const result = await paymentService.recordClientFailure({
    userId: req.auth.id,
    bookingId: req.body.booking_id,
    providerOrderId: req.body.razorpay_order_id ?? null,
    reason: req.body.reason ?? null,
  });

  res.json({
    data: result.booking,
    meta: { retry_seconds_remaining: result.retry_seconds_remaining },
  });
});

/** GET /api/v1/payments/:bookingId/status */
const status = asyncHandler(async (req, res) => {
  const data = await paymentService.getStatus({
    userId: req.auth.id,
    bookingId: req.params.bookingId,
  });
  res.json({ data });
});

/**
 * POST /api/v1/payments/:bookingId/reconcile
 *
 * For the case where neither the callback nor the webhook arrived — the app was
 * killed mid-checkout. Asks the provider directly rather than guessing.
 */
const reconcile = asyncHandler(async (req, res) => {
  const result = await paymentService.reconcile({
    userId: req.auth.id,
    bookingId: req.params.bookingId,
  });
  res.json({ data: result.booking, meta: { reconciled: result.reconciled, reason: result.reason } });
});

/**
 * POST /api/v1/payments/webhook
 *
 * Unauthenticated by token, authenticated by body signature. Deliberately returns
 * 200 for anything it successfully understood — including events it ignores —
 * because a non-2xx makes the provider retry forever.
 */
const webhook = asyncHandler(async (req, res) => {
  const signature = req.get('x-razorpay-signature');

  const result = await paymentService.handleWebhook({
    // Retained by the JSON body parser in app.js specifically for this route: the
    // signature covers the exact bytes received, so re-serialising would break it.
    rawBody: req.rawBody,
    signature,
    parsedBody: req.body,
  });

  logger.info({ result }, 'Webhook processed');
  res.status(200).json({ received: true, ...result });
});

module.exports = { createOrder, verify, failed, status, reconcile, webhook };
