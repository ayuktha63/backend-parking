'use strict';

/**
 * Booking HTTP layer.
 *
 * Thin by design: every handler resolves the caller's identity from `req.auth` —
 * never from the body or the path — and hands off to the service. The identity of
 * the actor is the one thing an HTTP layer must not delegate.
 */

const bookingService = require('../services/bookingService');
const { asyncHandler } = require('./authController');

/* ── holds ─────────────────────────────────────────────────────────────────── */

/** POST /api/v1/holds */
const createHold = asyncHandler(async (req, res) => {
  const hold = await bookingService.createHold({
    userId: req.auth.id,
    parkingAreaId: req.body.parking_area_id,
    slotId: req.body.slot_id,
    startAt: req.body.start_at,
    durationMinutes: req.body.duration_minutes,
  });
  res.status(201).json({ data: hold });
});

/**
 * GET /api/v1/holds/current
 *
 * Restores the countdown after the app is killed and relaunched. Without this the
 * user returns to a screen that has forgotten it is holding a slot they are paying
 * attention to.
 */
const currentHold = asyncHandler(async (req, res) => {
  const hold = await bookingService.getActiveHold(req.auth.id);
  res.json({ data: hold });
});

/** POST /api/v1/holds/:holdId/extend */
const extendHold = asyncHandler(async (req, res) => {
  const hold = await bookingService.extendHold({
    userId: req.auth.id,
    holdId: req.params.holdId,
  });
  res.json({ data: hold });
});

/** DELETE /api/v1/holds/:holdId */
const releaseHold = asyncHandler(async (req, res) => {
  const result = await bookingService.releaseHold({
    userId: req.auth.id,
    holdId: req.params.holdId,
  });
  res.json({ data: result });
});

/* ── bookings ──────────────────────────────────────────────────────────────── */

/**
 * POST /api/v1/bookings
 *
 * 201 for a booking that was created, 200 when an idempotency key matched an
 * existing one — so a client can tell "this is new" from "you already had this"
 * without parsing the body.
 */
const create = asyncHandler(async (req, res) => {
  const { booking, created } = await bookingService.createFromHold({
    userId: req.auth.id,
    holdId: req.body.hold_id,
    vehicleId: req.body.vehicle_id ?? null,
    numberPlate: req.body.number_plate ?? null,
    notes: req.body.notes ?? null,
    idempotencyKey: req.body.idempotency_key ?? null,
  });

  res.status(created ? 201 : 200).json({ data: booking, meta: { created } });
});

/** GET /api/v1/bookings */
const list = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const result = await bookingService.listForUser({
    userId: req.auth.id,
    bucket: q.bucket,
    limit: q.limit,
    offset: q.offset,
  });

  res.json({
    data: result.items,
    meta: { page: result.page, bucket: q.bucket },
  });
});

/** GET /api/v1/bookings/counts — badges on the four tabs, in one round trip. */
const counts = asyncHandler(async (req, res) => {
  const data = await bookingService.getCountsForUser(req.auth.id);
  res.json({ data });
});

/**
 * GET /api/v1/bookings/current
 *
 * The active-parking card on Home. Returns `null` data when there is nothing
 * active — an explicitly empty answer, not a 404, because "you have no active
 * parking" is a normal state rather than a missing resource.
 */
const current = asyncHandler(async (req, res) => {
  const data = await bookingService.getCurrentForUser(req.auth.id);
  res.json({ data });
});

/** GET /api/v1/bookings/:bookingId */
const detail = asyncHandler(async (req, res) => {
  const data = await bookingService.getForUser({
    userId: req.auth.id,
    bookingId: req.params.bookingId,
  });
  res.json({ data });
});

/**
 * GET /api/v1/bookings/:bookingId/cancellation-preview
 *
 * So the confirmation dialog states the real refund. The old flow said "Booking
 * Cancelled" and never mentioned money.
 */
const cancellationPreview = asyncHandler(async (req, res) => {
  const data = await bookingService.cancellationPreview({
    userId: req.auth.id,
    bookingId: req.params.bookingId,
  });
  res.json({ data });
});

/** POST /api/v1/bookings/:bookingId/cancel */
const cancel = asyncHandler(async (req, res) => {
  const result = await bookingService.cancel({
    userId: req.auth.id,
    bookingId: req.params.bookingId,
    reason: req.body?.reason ?? null,
    actorType: 'customer',
  });
  res.json({ data: result.booking, meta: { refund: result.refund, changed: result.changed } });
});

/** POST /api/v1/bookings/:bookingId/check-in */
const checkIn = asyncHandler(async (req, res) => {
  const result = await bookingService.checkIn({
    bookingId: req.params.bookingId,
    userId: req.auth.id,
    actorType: 'customer',
  });
  res.json({ data: result.booking, meta: { changed: result.changed } });
});

/** POST /api/v1/bookings/:bookingId/check-out */
const checkOut = asyncHandler(async (req, res) => {
  const result = await bookingService.checkOut({
    bookingId: req.params.bookingId,
    userId: req.auth.id,
    actorType: 'customer',
  });
  res.json({
    data: result.booking,
    meta: { settlement: result.settlement, changed: result.changed },
  });
});

module.exports = {
  createHold,
  currentHold,
  extendHold,
  releaseHold,
  create,
  list,
  counts,
  current,
  detail,
  cancellationPreview,
  cancel,
  checkIn,
  checkOut,
};
