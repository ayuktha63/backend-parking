'use strict';

/**
 * /api/v1/payments.
 *
 * The webhook is mounted BEFORE the auth guard, because a payment provider has no
 * session. It is authenticated by an HMAC over the request body instead — see
 * paymentProvider.verifyWebhookSignature.
 *
 * Everything else requires a signed-in customer.
 */

const express = require('express');
const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { limiters } = require('../../middleware/rateLimit');
const schemas = require('../../validators/booking');
const controller = require('../../controllers/paymentController');

const router = express.Router();

/**
 * Provider webhook. Unauthenticated by token, verified by signature.
 *
 * Not rate-limited: throttling a payment provider's retries would delay the
 * confirmation of bookings people have already paid for.
 */
router.post('/webhook', controller.webhook);

router.use(requireAuth, requireRole('customer'));

router.post('/order', limiters.write, validate(schemas.createPaymentOrder), controller.createOrder);
router.post('/verify', limiters.write, validate(schemas.verifyPayment), controller.verify);
router.post('/failed', limiters.write, validate(schemas.failPayment), controller.failed);

router.get(
  '/:bookingId/status',
  limiters.read,
  validate(schemas.paymentStatus),
  controller.status
);
router.post(
  '/:bookingId/reconcile',
  limiters.write,
  validate(schemas.paymentStatus),
  controller.reconcile
);

module.exports = router;
