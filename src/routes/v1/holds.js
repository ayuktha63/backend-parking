'use strict';

/**
 * /api/v1/holds — temporary slot reservations.
 *
 * A hold is what makes the booking flow honest: from the moment the customer picks
 * a slot to the moment they pay, that slot is theirs and is visibly unavailable to
 * everyone else. Without it, two people can be filling in the same checkout form.
 */

const express = require('express');
const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { limiters } = require('../../middleware/rateLimit');
const schemas = require('../../validators/booking');
const controller = require('../../controllers/bookingController');

const router = express.Router();

router.use(requireAuth, requireRole('customer'));

router.get('/current', controller.currentHold);

router.post('/', limiters.write, validate(schemas.createHold), controller.createHold);
router.post(
  '/:holdId/extend',
  limiters.write,
  validate(schemas.holdParam),
  controller.extendHold
);
router.delete('/:holdId', limiters.write, validate(schemas.holdParam), controller.releaseHold);

module.exports = router;
