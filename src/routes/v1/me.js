'use strict';

/**
 * /api/v1/me — the authenticated caller's own profile and vehicles.
 *
 * Every route here is scoped to `req.auth.id`. There is no `:phone` or `:userId`
 * path parameter anywhere, which is the structural fix for the old
 * `GET /api/users/bookings/:phone` — an unauthenticated endpoint that returned any
 * person's complete movement history to anyone who knew their number.
 */

const express = require('express');
const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { limiters } = require('../../middleware/rateLimit');
const { z, vehicleType, numberPlate, id } = require('../../validators/common');
const schemas = require('../../validators/auth');
const controller = require('../../controllers/authController');

const router = express.Router();

router.use(requireAuth);

router.get('/', controller.me);
router.patch('/', limiters.write, validate(schemas.updateMe), controller.updateMe);

/* ── saved vehicles (customers only) ───────────────────────────────────────── */

const addVehicleSchema = {
  body: z.object({
    vehicle_type: vehicleType,
    number_plate: numberPlate,
    label: z.string().trim().max(40).optional(),
    is_default: z.boolean().default(false),
  }),
};

const vehicleParam = { params: z.object({ vehicleId: id }) };

router.get('/vehicles', requireRole('customer'), controller.listVehicles);

router.post(
  '/vehicles',
  requireRole('customer'),
  limiters.write,
  validate(addVehicleSchema),
  controller.addVehicle
);

router.post(
  '/vehicles/:vehicleId/default',
  requireRole('customer'),
  limiters.write,
  validate(vehicleParam),
  controller.setDefaultVehicle
);

router.delete(
  '/vehicles/:vehicleId',
  requireRole('customer'),
  limiters.write,
  validate(vehicleParam),
  controller.deleteVehicle
);

module.exports = router;
