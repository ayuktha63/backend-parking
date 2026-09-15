'use strict';

/**
 * /api/v1/owner — the operator surface.
 *
 * Two guards on the router itself, so no individual route can forget them:
 *   requireAuth        a valid access token
 *   requireRole('owner')  a customer token must not reach any of this
 *
 * Resource-level ownership — "is this YOUR lot, YOUR booking, YOUR slot?" — needs a
 * database lookup and is therefore enforced in operatorService, on every call,
 * against `req.auth.id`. No route here takes an owner id.
 */

const express = require('express');
const parkingPhotoService = require('../../services/parkingPhotoService');
const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { limiters } = require('../../middleware/rateLimit');
const schemas = require('../../validators/operator');
const controller = require('../../controllers/operatorController');

const router = express.Router();

router.use(requireAuth, requireRole('owner'));

/* ── the operational screens ───────────────────────────────────────────────── */

router.get('/dashboard', limiters.read, validate(schemas.dashboard), controller.dashboard);
router.get('/arrivals', limiters.read, validate(schemas.arrivals), controller.arrivals);
router.get('/grid', limiters.read, validate(schemas.grid), controller.grid);
router.get('/profile', limiters.read, controller.profile);

/* ── arrival desk ──────────────────────────────────────────────────────────── */

/**
 * POST, not GET: a booking code is the credential that admits a car, and a GET
 * would place it in access logs, proxy caches and browser history.
 *
 * Rate-limited as a write for the same reason — it is the one endpoint where
 * guessing is worth something, even though a wrong guess reveals nothing.
 */
router.post('/lookup', limiters.write, validate(schemas.lookup), controller.lookup);
router.post(
  '/lookup/plate',
  limiters.write,
  validate(schemas.lookupByPlate),
  controller.lookupByPlate
);

/* ── bookings ──────────────────────────────────────────────────────────────── */

router.get('/bookings', limiters.read, validate(schemas.bookings), controller.bookings);
router.get(
  '/bookings/:bookingId',
  limiters.read,
  validate(schemas.bookingParam),
  controller.bookingDetail
);
router.get(
  '/bookings/:bookingId/check-out-preview',
  limiters.read,
  validate(schemas.bookingParam),
  controller.checkOutPreview
);

router.post(
  '/bookings/:bookingId/check-in',
  limiters.write,
  validate(schemas.bookingParam),
  controller.checkIn
);
router.post(
  '/bookings/:bookingId/check-out',
  limiters.write,
  validate(schemas.bookingParam),
  controller.checkOut
);
router.post(
  '/bookings/:bookingId/no-show',
  limiters.write,
  validate(schemas.noShow),
  controller.markNoShow
);

/* ── slots ─────────────────────────────────────────────────────────────────── */

router.get('/slots/:slotId', limiters.read, validate(schemas.slotParam), controller.slotDetail);
router.post(
  '/slots/:slotId/service',
  limiters.write,
  validate(schemas.slotService),
  controller.setSlotService
);

/* ── configuration ─────────────────────────────────────────────────────────── */

/**
 * Everything under /config can change what customers see and what they are charged,
 * so every write here is rate-limited as a write and carries either an impact hash
 * (capacity, which can strand a reservation) or a version token (everything else,
 * which cannot but can still be overwritten by a second operator).
 */

router.get('/config', limiters.read, validate(schemas.configQuery), controller.config);
router.get('/config/grid', limiters.read, validate(schemas.configQuery), controller.configGrid);
router.get('/config/audit', limiters.read, validate(schemas.auditQuery), controller.configAudit);

// Capacity: preview, then apply with the hash. Two steps, deliberately — this is
// the operation that used to run DELETE FROM bookings.
router.post(
  '/config/capacity/preview',
  limiters.write,
  validate(schemas.capacityPreview),
  controller.capacityPreview
);
router.post(
  '/config/capacity',
  limiters.write,
  validate(schemas.capacityApply),
  controller.capacityApply
);

router.post(
  '/config/pricing/preview',
  limiters.write,
  validate(schemas.pricingPreview),
  controller.pricingPreview
);
router.post(
  '/config/pricing',
  limiters.write,
  validate(schemas.pricingApply),
  controller.pricingApply
);

router.post('/config/hours', limiters.write, validate(schemas.hoursApply), controller.hoursApply);
router.post(
  '/config/amenities',
  limiters.write,
  validate(schemas.amenitiesApply),
  controller.amenitiesApply
);
router.post(
  '/config/details',
  limiters.write,
  validate(schemas.detailsApply),
  controller.detailsApply
);


/* ── photographs ───────────────────────────────────────────────────────────── */

/**
 * Upload is `express.raw`, not multipart.
 *
 * A multipart parser would be a whole dependency for one endpoint, and a
 * single-file upload has no fields to parse — the bytes ARE the body and the
 * filename is generated server-side regardless. The limit here is a hard stop
 * at the transport layer; the service checks the size again and, unlike this,
 * also checks that the bytes actually look like the image type they claim.
 */
router.get('/config/photos', limiters.read, controller.photos);

router.post(
  '/config/photos',
  limiters.write,
  express.raw({
    type: parkingPhotoService.ACCEPTED_TYPES,
    limit: parkingPhotoService.MAX_BYTES,
  }),
  controller.photoAdd
);

router.post('/config/photos/:photoId/cover', limiters.write, controller.photoSetCover);
router.delete('/config/photos/:photoId', limiters.write, controller.photoDelete);

module.exports = router;
