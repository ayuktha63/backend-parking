'use strict';

/**
 * Booking and payment request schemas.
 *
 * What is conspicuously absent from every schema here is an `amount` field. The
 * server computes the price; there is no request shape through which a client could
 * propose one, which is enforcement rather than convention.
 */

const { z, id, vehicleType, instant, durationMinutes } = require('./common');
const { config } = require('../config');

/** A client-generated idempotency key. Optional, but strongly encouraged. */
const idempotencyKey = z
  .string()
  .trim()
  .min(8, 'Idempotency key is too short')
  .max(64, 'Idempotency key is too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency key may contain letters, numbers, - and _ only')
  .optional();

/* ── holds ─────────────────────────────────────────────────────────────────── */

const createHold = {
  body: z.object({
    parking_area_id: id,
    slot_id: id,
    start_at: instant.optional(),
    duration_minutes: durationMinutes.default(config.booking.defaultDurationMinutes),
  }),
};

const holdParam = { params: z.object({ holdId: id }) };

/* ── bookings ──────────────────────────────────────────────────────────────── */

/**
 * Creating a booking references a hold, not a slot.
 *
 * That ordering is deliberate: it is impossible to create a booking without having
 * first taken a hold, so the slot is already reserved to this user before any of
 * the payment ceremony starts.
 */
const createBooking = {
  body: z
    .object({
      hold_id: id,
      // One of these identifies the vehicle. Both absent is rejected below.
      vehicle_id: id.optional(),
      number_plate: z
        .string()
        .trim()
        .min(4, 'Vehicle number looks too short')
        .max(16, 'Vehicle number looks too long')
        .transform((v) => v.toUpperCase().replace(/\s+/g, ''))
        .optional(),
      notes: z.string().trim().max(500).optional(),
      idempotency_key: idempotencyKey,
    })
    .refine((b) => b.vehicle_id !== undefined || b.number_plate !== undefined, {
      message: 'Choose a saved vehicle or enter its number',
      path: ['vehicle_id'],
    }),
};

const bookingParam = { params: z.object({ bookingId: id }) };

const listBookings = {
  query: z.object({
    bucket: z.enum(['upcoming', 'active', 'completed', 'cancelled']).default('upcoming'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  }),
};

const cancelBooking = {
  params: z.object({ bookingId: id }),
  body: z
    .object({
      reason: z.string().trim().max(300).optional(),
    })
    .default({}),
};

const checkInBooking = {
  params: z.object({ bookingId: id }),
  body: z.object({}).default({}),
};

/* ── payments ──────────────────────────────────────────────────────────────── */

const createPaymentOrder = {
  body: z.object({
    booking_id: id,
    idempotency_key: idempotencyKey,
  }),
};

/**
 * The Checkout result the device hands back.
 *
 * All three fields are required: without the signature there is nothing to verify,
 * and a request missing it must fail rather than fall back to trusting the rest.
 */
const verifyPayment = {
  body: z.object({
    booking_id: id,
    razorpay_order_id: z.string().trim().min(4).max(120),
    razorpay_payment_id: z.string().trim().min(4).max(120),
    razorpay_signature: z.string().trim().min(16).max(256),
  }),
};

const failPayment = {
  body: z.object({
    booking_id: id,
    razorpay_order_id: z.string().trim().min(4).max(120).optional(),
    reason: z.string().trim().max(300).optional(),
  }),
};

const paymentStatus = { params: z.object({ bookingId: id }) };

/* ── availability for the slot picker ──────────────────────────────────────── */

/**
 * Used by the Slot & Time screen when the user changes the window. Distinct from
 * the discovery schema because `vehicle_type` is required here: by this point the
 * user has chosen one, and defaulting it would silently show car slots to someone
 * booking a bike.
 */
const slotAvailability = {
  params: z.object({ id }),
  query: z.object({
    vehicle_type: vehicleType,
    start_at: instant.optional(),
    duration_minutes: durationMinutes.default(config.booking.defaultDurationMinutes),
  }),
};

module.exports = {
  createHold,
  holdParam,
  createBooking,
  bookingParam,
  listBookings,
  cancelBooking,
  checkInBooking,
  createPaymentOrder,
  verifyPayment,
  failPayment,
  paymentStatus,
  slotAvailability,
};
