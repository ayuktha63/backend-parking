'use strict';

/**
 * Bookings and their audit trail.
 *
 * Two rules this repository exists to enforce:
 *
 *   1. NOTHING IS EVER DELETED. The previous implementation deleted booking rows on
 *      cancel, on completion, on a five-minute unverified sweep, and on any capacity
 *      change. A customer's history simply evaporated, and so did the operator's.
 *      Every terminal state here is a status transition plus a `booking_events` row.
 *
 *   2. OWNERSHIP IS A QUERY PREDICATE, NOT A CHECK. Every read that belongs to a
 *      customer takes `userId` and puts it in the WHERE clause. There is no
 *      `findById` that a controller could accidentally call without it — the
 *      unscoped variant is named `findByIdUnscoped` so using it is a deliberate act.
 */

const db = require('../db');

/* ── column sets ───────────────────────────────────────────────────────────── */

/**
 * Everything the apps render, joined once.
 *
 * The old `GET /api/users/bookings/:phone` returned bare booking rows, so the app
 * then fetched each parking area separately to learn its name — an N+1 on the
 * single most-visited screen.
 */
const BOOKING_SELECT = `
  b.id,
  b.booking_code,
  b.status,
  b.user_id,
  b.parking_id,
  b.parking_slot_id,
  b.vehicle_id,
  b.vehicle_type,
  b.number_plate,
  b.phone,
  b.entry_time,
  b.expected_exit_time,
  b.exit_time,
  b.duration_minutes,
  b.amount_paise,
  b.final_amount_paise,
  b.currency,
  b.pricing_snapshot,
  b.checkout_snapshot,
  b.checked_in_at,
  b.checked_out_at,
  b.completed_at,
  b.cancelled_at,
  b.cancelled_by,
  b.cancellation_reason,
  b.source,
  b.notes,
  b.created_at,
  b.updated_at,

  ps.code        AS slot_code,
  ps.row_label   AS slot_row,
  ps.position    AS slot_position,
  ps.slot_number AS slot_number,
  ps.slot_class  AS slot_class,

  pa.name         AS parking_name,
  pa.address_line AS parking_address_line,
  pa.locality     AS parking_locality,
  pa.city         AS parking_city,
  pa.landmark     AS parking_landmark,
  pa.lat          AS parking_lat,
  pa.lng          AS parking_lng,
  pa.contact_phone AS parking_contact_phone,
  -- The lot's cover photograph, so a booking row and the Active Parking screen
  -- show the same place the customer chose on the discovery card. Without it
  -- the booking screens were the only place in the product with no imagery.
  (SELECT ph.url FROM parking_photos ph
    WHERE ph.parking_area_id = pa.id
    ORDER BY ph.is_cover DESC, ph.sort_order ASC, ph.id ASC
    LIMIT 1) AS parking_cover_photo_url,
  pa.instructions AS parking_instructions,
  pa.owner_id     AS parking_owner_id,

  v.number_plate AS vehicle_plate,
  v.label        AS vehicle_label,

  u.name AS user_name,

  pay.status              AS payment_status,
  pay.amount_paise        AS payment_amount_paise,
  pay.provider_payment_id AS payment_reference,
  pay.verified_at         AS payment_verified_at,
  pay.amount_refunded_paise AS payment_refunded_paise
`;

const BOOKING_JOINS = `
  FROM bookings b
  LEFT JOIN parking_slots ps ON ps.id = b.parking_slot_id
  LEFT JOIN parking_areas pa ON pa.id = b.parking_id
  LEFT JOIN vehicles      v  ON v.id  = b.vehicle_id
  LEFT JOIN users         u  ON u.id  = b.user_id
  -- The payment that matters is the settled one; failing that, the most recent.
  LEFT JOIN LATERAL (
    SELECT p.status, p.amount_paise, p.provider_payment_id, p.verified_at,
           p.amount_refunded_paise
      FROM payments p
     WHERE p.booking_id = b.id
     ORDER BY (p.status = 'PAID') DESC, p.created_at DESC
     LIMIT 1
  ) pay ON TRUE
`;

/** States in which a booking still occupies its slot. */
const ACTIVE_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'];

/* ── reads ─────────────────────────────────────────────────────────────────── */

/** A booking, scoped to its owner. Returns null when it is not theirs. */
async function findByIdForUser({ bookingId, userId, client = null }) {
  return db.queryOne(
    `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS} WHERE b.id = $1 AND b.user_id = $2`,
    [bookingId, userId],
    client
  );
}

async function findByCodeForUser({ code, userId, client = null }) {
  return db.queryOne(
    `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
      WHERE upper(b.booking_code) = upper($1) AND b.user_id = $2`,
    [code, userId],
    client
  );
}

/**
 * Unscoped read. Used by payment verification and webhooks, which arrive with no
 * session, and by the operator flows, which authorise on lot ownership instead.
 * Named so that reaching for it is a decision.
 */
async function findByIdUnscoped(bookingId, client = null) {
  return db.queryOne(
    `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS} WHERE b.id = $1`,
    [bookingId],
    client
  );
}

/** Row-level lock for a lifecycle transition. Must run inside a transaction. */
async function lockById(bookingId, client) {
  return db.queryOne(
    `SELECT b.* FROM bookings b WHERE b.id = $1 FOR UPDATE`,
    [bookingId],
    client
  );
}

async function findByIdempotencyKey({ userId, key, client = null }) {
  if (!key) return null;
  return db.queryOne(
    `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
      WHERE b.user_id = $1 AND b.idempotency_key = $2`,
    [userId, key],
    client
  );
}

/**
 * The Bookings tab.
 *
 * `bucket` maps the four tabs onto statuses, so the client never has to know which
 * statuses constitute "upcoming" — a rule that belongs on the server because the
 * operator app has to agree with it.
 */
const BUCKETS = {
  upcoming: {
    statuses: ['PENDING_PAYMENT', 'CONFIRMED'],
    order: 'b.entry_time ASC',
  },
  active: {
    statuses: ['CHECKED_IN'],
    order: 'b.checked_in_at DESC',
  },
  completed: {
    statuses: ['COMPLETED', 'NO_SHOW'],
    order: 'COALESCE(b.completed_at, b.expected_exit_time, b.created_at) DESC',
  },
  cancelled: {
    statuses: ['CANCELLED', 'EXPIRED'],
    order: 'COALESCE(b.cancelled_at, b.updated_at) DESC',
  },
};

async function listForUser({ userId, bucket = 'upcoming', limit = 20, offset = 0, client = null }) {
  const spec = BUCKETS[bucket] || BUCKETS.upcoming;

  return db.queryMany(
    `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
      WHERE b.user_id = $1
        AND b.status = ANY($2::text[])
      ORDER BY ${spec.order}
      LIMIT $3 OFFSET $4`,
    [userId, spec.statuses, limit + 1, offset],
    client
  );
}

/** Counts per bucket, so the tabs can carry a badge without four round trips. */
async function countsForUser(userId, client = null) {
  const row = await db.queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('PENDING_PAYMENT','CONFIRMED'))::int AS upcoming,
       COUNT(*) FILTER (WHERE status = 'CHECKED_IN')::int                     AS active,
       COUNT(*) FILTER (WHERE status IN ('COMPLETED','NO_SHOW'))::int         AS completed,
       COUNT(*) FILTER (WHERE status IN ('CANCELLED','EXPIRED'))::int         AS cancelled
     FROM bookings WHERE user_id = $1`,
    [userId],
    client
  );
  return row || { upcoming: 0, active: 0, completed: 0, cancelled: 0 };
}

/**
 * The one booking that should dominate the Home screen, if any.
 *
 * Priority: parked right now, then arriving soonest within the check-in window.
 * Returning at most one keeps the caller from having to decide which is "the"
 * active session.
 */
async function findCurrentForUser({ userId, earlyMinutes = 30, client = null }) {
  return db.queryOne(
    `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
      WHERE b.user_id = $1
        AND (
          b.status = 'CHECKED_IN'
          OR (
            b.status = 'CONFIRMED'
            AND b.entry_time IS NOT NULL
            AND b.entry_time <= NOW() + ($2 || ' minutes')::interval
            AND COALESCE(b.expected_exit_time, b.entry_time) > NOW() - interval '2 hours'
          )
        )
      ORDER BY (b.status = 'CHECKED_IN') DESC, b.entry_time ASC
      LIMIT 1`,
    [userId, earlyMinutes],
    client
  );
}

/** Live bookings for one customer — the per-account cap. */
async function countActiveForUser(userId, client = null) {
  const row = await db.queryOne(
    `SELECT COUNT(*)::int AS n
       FROM bookings
      WHERE user_id = $1
        AND status = ANY($2::text[])
        AND COALESCE(expected_exit_time, entry_time) > NOW()`,
    [userId, ACTIVE_STATUSES],
    client
  );
  return row?.n ?? 0;
}

/* ── writes ────────────────────────────────────────────────────────────────── */

/**
 * Creates a booking in PENDING_PAYMENT.
 *
 * `booking_code` comes from the database function added in 0009, not from the
 * client and not from `Random()`. The exclusion constraint from 0007 is what
 * actually guarantees the slot is not double-booked; this insert simply fails with
 * 23P01 if it is, which the error handler turns into SLOT_UNAVAILABLE.
 */
async function create(
  {
    userId,
    parkingAreaId,
    slotId,
    slotNumber,
    vehicleType,
    vehicleId,
    numberPlate,
    phone,
    entryTime,
    expectedExitTime,
    durationMinutes,
    amountPaise,
    pricingSnapshot,
    holdId,
    idempotencyKey,
    source = 'customer_app',
    createdByOwnerId = null,
  },
  client
) {
  return db.queryOne(
    // The legacy `amount` (numeric rupees) and `payment_id` columns are NOT
    // written here, and both have NOT NULL DEFAULTs so omitting them is safe.
    //
    // Two reasons. The practical one: migration 0008 renames `amount` to
    // `amount_legacy_rupees` once legacy traffic reaches zero, so an INSERT naming
    // `amount` fails with 42703 on any database past 0008 — which is exactly how
    // this was found, on the first real booking ever attempted.
    //
    // The substantive one: a rupee column kept "in step" with amount_paise is a
    // second source of truth for money, which is the defect this codebase exists
    // to remove. `amount_paise` is the only amount. Bookings created through
    // /api/v1 therefore read as 0 rupees through the deprecated /api/* routes —
    // acceptable, because those routes serve already-shipped builds that cannot
    // see v1 bookings anyway, and 0008 removes them entirely.
    `INSERT INTO bookings (
       user_id, parking_id, parking_slot_id, slot_number, vehicle_type, vehicle_id,
       number_plate, phone, entry_time, expected_exit_time, duration_minutes,
       amount_paise, currency, pricing_snapshot, slot_hold_id, idempotency_key,
       status, source, created_by_owner_id, booking_code,
       created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       $12, 'INR', $13, $14, $15,
       'PENDING_PAYMENT', $16, $17, generate_booking_code(),
       NOW(), NOW()
     )
     RETURNING id`,
    [
      userId,
      parkingAreaId,
      slotId,
      slotNumber,
      vehicleType,
      vehicleId,
      numberPlate || '',
      phone || '',
      entryTime,
      expectedExitTime,
      durationMinutes,
      amountPaise,
      JSON.stringify(pricingSnapshot || {}),
      holdId,
      idempotencyKey,
      source,
      createdByOwnerId,
    ],
    client
  );
}

/**
 * Applies a status transition, conditional on the current status.
 *
 * The `WHERE status = ANY(from)` predicate is the concurrency control: two
 * simultaneous cancels cannot both succeed, because the second matches no row and
 * returns null. The caller treats a null return as "someone got there first",
 * which is a different outcome from an error.
 */
async function transition(
  { bookingId, from, to, patch = {}, client },
) {
  const sets = ['status = $3', 'updated_at = NOW()'];
  const params = [bookingId, from, to];
  let n = 3;

  for (const [column, value] of Object.entries(patch)) {
    n += 1;
    sets.push(`${column} = $${n}`);
    params.push(value);
  }

  return db.queryOne(
    `UPDATE bookings
        SET ${sets.join(', ')}
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING id, status, booking_code, user_id, parking_id, parking_slot_id,
                slot_number, vehicle_type, entry_time, expected_exit_time,
                amount_paise, final_amount_paise`,
    params,
    client
  );
}

/**
 * Appends to the audit trail.
 *
 * Every transition writes one of these. It is what makes "why is this booking
 * cancelled?" answerable months later, and it is append-only by design.
 */
async function recordEvent(
  { bookingId, eventType, fromStatus = null, toStatus = null, actorType = 'system', actorId = null, metadata = {} },
  client = null
) {
  return db.queryOne(
    `INSERT INTO booking_events
       (booking_id, event_type, from_status, to_status, actor_type, actor_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      bookingId,
      eventType,
      fromStatus,
      toStatus,
      actorType,
      actorId === null ? null : String(actorId),
      JSON.stringify(metadata || {}),
    ],
    client
  );
}

async function listEvents(bookingId, client = null) {
  return db.queryMany(
    `SELECT id, event_type, from_status, to_status, actor_type, metadata, created_at
       FROM booking_events
      WHERE booking_id = $1
      ORDER BY created_at ASC, id ASC`,
    [bookingId],
    client
  );
}

/* ── operator reads ────────────────────────────────────────────────────────── */

/**
 * Bookings for one lot in a window. Drives the operator's arrivals list and the
 * live grid. Authorisation is the caller's job: `ownerId` must already have been
 * verified against `parking_areas.owner_id`.
 */
async function listForParkingArea({
  parkingAreaId,
  statuses = ACTIVE_STATUSES,
  fromTime = null,
  toTime = null,
  search = null,
  limit = 50,
  offset = 0,
  client = null,
}) {
  return db.queryMany(
    `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
      WHERE b.parking_id = $1
        AND b.status = ANY($2::text[])
        AND ($3::timestamptz IS NULL OR COALESCE(b.expected_exit_time, b.entry_time) >= $3)
        AND ($4::timestamptz IS NULL OR b.entry_time <= $4)
        AND (
          $5::text IS NULL
          OR upper(b.booking_code) LIKE '%' || upper($5) || '%'
          OR upper(COALESCE(b.number_plate, '')) LIKE '%' || upper(replace($5, ' ', '')) || '%'
          OR COALESCE(b.phone, '') LIKE '%' || $5 || '%'
        )
      ORDER BY b.entry_time ASC
      LIMIT $6 OFFSET $7`,
    [parkingAreaId, statuses, fromTime, toTime, search, limit + 1, offset],
    client
  );
}

/** Find a booking by the code the driver reads out at the barrier. */
async function findByCodeForParkingArea({ code, parkingAreaId, client = null }) {
  return db.queryOne(
    `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
      WHERE upper(b.booking_code) = upper($1) AND b.parking_id = $2`,
    [code, parkingAreaId],
    client
  );
}

module.exports = {
  ACTIVE_STATUSES,
  BUCKETS,
  findByIdForUser,
  findByCodeForUser,
  findByIdUnscoped,
  findByIdempotencyKey,
  lockById,
  listForUser,
  countsForUser,
  findCurrentForUser,
  countActiveForUser,
  create,
  transition,
  recordEvent,
  listEvents,
  listForParkingArea,
  findByCodeForParkingArea,
};
