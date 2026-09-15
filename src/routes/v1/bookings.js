'use strict';

/**
 * /api/v1/bookings.
 *
 * Note what is not here: no `:phone` and no `:userId`. Every route reads
 * `req.auth.id`, which is the structural fix for the old
 * `GET /api/users/bookings/:phone` — unauthenticated, and therefore a lookup of any
 * person's complete movement history by anyone who knew their number.
 */

const express = require('express');
const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { limiters } = require('../../middleware/rateLimit');
const schemas = require('../../validators/booking');
const controller = require('../../controllers/bookingController');

const router = express.Router();

router.use(requireAuth, requireRole('customer'));

// Static paths before /:bookingId, or they are swallowed by it.
router.get('/counts', controller.counts);
router.get('/current', controller.current);

router.get('/', limiters.read, validate(schemas.listBookings), controller.list);
router.post('/', limiters.write, validate(schemas.createBooking), controller.create);

router.get('/:bookingId', limiters.read, validate(schemas.bookingParam), controller.detail);

router.get(
  '/:bookingId/cancellation-preview',
  limiters.read,
  validate(schemas.bookingParam),
  controller.cancellationPreview
);

router.post(
  '/:bookingId/cancel',
  limiters.write,
  validate(schemas.cancelBooking),
  controller.cancel
);
router.post(
  '/:bookingId/check-in',
  limiters.write,
  validate(schemas.checkInBooking),
  controller.checkIn
);
router.post(
  '/:bookingId/check-out',
  limiters.write,
  validate(schemas.checkInBooking),
  controller.checkOut
);

module.exports = router;
