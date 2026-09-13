'use strict';

/**
 * Parking slots and holds.
 *
 * ONE availability algorithm, used by the customer app, the operator app and the
 * pricing engine. The old system had three competing definitions:
 *
 *   - `GET /api/parking_areas/:id/slots`       time-aware, ±10 min window
 *   - `GET /api/owner/parking_areas/:id/slots` time-blind, any booking = occupied
 *   - `parking_areas.available_*_slots`        a drifting ±1 counter
 *
 * The two apps could legitimately disagree about whether slot 4 was free.
 */

const db = require('../db');

const SLOT_COLUMNS = `
  ps.id, ps.parking_area_id, ps.vehicle_type, ps.code, ps.row_label,
  ps.position, ps.slot_number, ps.slot_class, ps.is_active, ps.closed_reason
`;

/**
 * Slot layout with derived state for a window.
 *
 * Returns real layout data — `row_label` and `position` — so the client can render
 * an actual parking layout. The old app invented lanes with
 * `slot_number <= 6 ? 'A' : 'B'`, so a 40-slot lot showed 6 slots in lane A and 34
 * in lane B, bearing no relation to the physical lot.
 *
 * Derived state, in priority order:
 *   closed    → is_active = false
 *   booked    → an active booking overlaps the window
 *   held      → someone holds it right now (held_by_you when it is the caller)
 *   available → otherwise
 *
 * @param {number|null} forUserId marks a hold as the caller's own
 */
async function getLayout({
  parkingAreaId,
  vehicleType,
  startAt,
  endAt,
  forUserId = null,
  client = null,
}) {
  return db.queryMany(
    `SELECT
       ${SLOT_COLUMNS},
       booking.id           AS booking_id,
       booking.entry_time   AS booked_from,
       booking.expected_exit_time AS booked_until,
       hold.id              AS hold_id,
       hold.hold_expires_at AS hold_expires_at,
       (hold.user_id IS NOT NULL AND hold.user_id = $5) AS held_by_you,
       CASE
         WHEN NOT ps.is_active        THEN 'closed'
         WHEN booking.id IS NOT NULL  THEN 'booked'
         WHEN hold.id IS NOT NULL     THEN 'held'
         ELSE 'available'
       END AS status
     FROM parking_slots ps

     LEFT JOIN LATERAL (
       SELECT b.id, b.entry_time, b.expected_exit_time
         FROM bookings b
        WHERE b.parking_slot_id = ps.id
          AND b.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
          AND tstzrange(b.entry_time, b.expected_exit_time, '[)')
              && tstzrange($3::timestamptz, $4::timestamptz, '[)')
        ORDER BY b.entry_time
        LIMIT 1
     ) booking ON TRUE

     LEFT JOIN LATERAL (
       SELECT h.id, h.hold_expires_at, h.user_id
         FROM slot_holds h
        WHERE h.parking_slot_id = ps.id
          AND h.hold_expires_at > NOW()
          AND h.consumed_at IS NULL
          AND h.released_at IS NULL
        ORDER BY h.created_at DESC
        LIMIT 1
     ) hold ON TRUE

     WHERE ps.parking_area_id = $1 AND ps.vehicle_type = $2
     ORDER BY ps.row_label ASC, ps.position ASC, ps.slot_number ASC`,
    [parkingAreaId, vehicleType, startAt, endAt, forUserId],
    client
  );
}

/** Counts only — used by cards and markers, where the full layout is wasted bytes. */
async function getAvailabilitySummary({
  parkingAreaId,
  vehicleType,
  startAt,
  endAt,
  client = null,
}) {
  const row = await db.queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE ps.is_active)::int AS total,
       COUNT(*) FILTER (WHERE NOT ps.is_active)::int AS closed,
       COUNT(*) FILTER (
         WHERE ps.is_active AND EXISTS (
           SELECT 1 FROM bookings b
            WHERE b.parking_slot_id = ps.id
              AND b.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
              AND tstzrange(b.entry_time, b.expected_exit_time, '[)')
                  && tstzrange($3::timestamptz, $4::timestamptz, '[)'))
       )::int AS booked,
       COUNT(*) FILTER (
         WHERE ps.is_active AND EXISTS (
           SELECT 1 FROM slot_holds h
            WHERE h.parking_slot_id = ps.id
              AND h.hold_expires_at > NOW()
              AND h.consumed_at IS NULL AND h.released_at IS NULL)
       )::int AS held
     FROM parking_slots ps
     WHERE ps.parking_area_id = $1 AND ps.vehicle_type = $2`,
    [parkingAreaId, vehicleType, startAt, endAt],
    client
  );

  const total = row?.total ?? 0;
  const booked = row?.booked ?? 0;
  const held = row?.held ?? 0;

  return {
    total,
    booked,
    held,
    closed: row?.closed ?? 0,
    available: Math.max(total - booked - held, 0),
  };
}

async function findById(slotId, client = null) {
  return db.queryOne(
    `SELECT ${SLOT_COLUMNS} FROM parking_slots ps WHERE ps.id = $1`,
    [slotId],
    client
  );
}

/** Legacy lookup path — the old API addressed slots by number, not id. */
async function findByNumber({ parkingAreaId, vehicleType, slotNumber, client = null }) {
  return db.queryOne(
    `SELECT ${SLOT_COLUMNS} FROM parking_slots ps
      WHERE ps.parking_area_id = $1 AND ps.vehicle_type = $2 AND ps.slot_number = $3`,
    [parkingAreaId, vehicleType, slotNumber],
    client
  );
}

/**
 * Whether a slot is free for a window.
 *
 * MUST be called inside a transaction that already holds the advisory lock for this
 * slot, otherwise it is a check-then-act race. The exclusion constraint added in
 * migration 0007 is the backstop if that discipline ever slips.
 */
async function isFreeForWindow({ slotId, startAt, endAt, ignoreHoldId = null, client }) {
  const row = await db.queryOne(
    `SELECT
       ps.is_active,
       EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.parking_slot_id = ps.id
            AND b.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
            AND tstzrange(b.entry_time, b.expected_exit_time, '[)')
                && tstzrange($2::timestamptz, $3::timestamptz, '[)')
       ) AS has_booking,
       EXISTS (
         SELECT 1 FROM slot_holds h
          WHERE h.parking_slot_id = ps.id
            AND h.hold_expires_at > NOW()
            AND h.consumed_at IS NULL AND h.released_at IS NULL
            AND ($4::bigint IS NULL OR h.id <> $4::bigint)
       ) AS has_hold
     FROM parking_slots ps WHERE ps.id = $1`,
    [slotId, startAt, endAt, ignoreHoldId],
    client
  );

  if (!row) return { free: false, reason: 'SLOT_NOT_FOUND' };
  if (!row.is_active) return { free: false, reason: 'SLOT_CLOSED' };
  if (row.has_booking) return { free: false, reason: 'SLOT_BOOKED' };
  if (row.has_hold) return { free: false, reason: 'SLOT_HELD' };
  return { free: true };
}

/* ── holds ─────────────────────────────────────────────────────────────────── */

const HOLD_COLUMNS = `
  h.id, h.parking_id, h.parking_slot_id, h.slot_number, h.vehicle_type,
  h.user_id, h.entry_time, h.duration_minutes, h.hold_expires_at,
  h.consumed_at, h.released_at, h.created_at
`;

async function createHold(
  { parkingAreaId, slotId, slotNumber, vehicleType, userId, phone, entryTime, durationMinutes, holdSeconds },
  client = null
) {
  return db.queryOne(
    `INSERT INTO slot_holds
       (parking_id, parking_slot_id, slot_number, vehicle_type, user_id, phone,
        entry_time, duration_minutes, hold_expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             NOW() + ($9 || ' seconds')::interval, NOW())
     RETURNING ${HOLD_COLUMNS.replace(/h\./g, '')}`,
    [
      parkingAreaId,
      slotId,
      slotNumber,
      vehicleType,
      userId,
      phone || '',
      entryTime,
      durationMinutes,
      holdSeconds,
    ],
    client
  );
}

async function findHoldById(holdId, client = null) {
  return db.queryOne(`SELECT ${HOLD_COLUMNS} FROM slot_holds h WHERE h.id = $1`, [holdId], client);
}

/** The caller's current live hold, if any — used to restore state after a reload. */
async function findActiveHoldForUser(userId, client = null) {
  return db.queryOne(
    `SELECT ${HOLD_COLUMNS}, ps.code AS slot_code, pa.name AS parking_name
       FROM slot_holds h
       JOIN parking_slots ps ON ps.id = h.parking_slot_id
       JOIN parking_areas pa ON pa.id = h.parking_id
      WHERE h.user_id = $1
        AND h.hold_expires_at > NOW()
        AND h.consumed_at IS NULL AND h.released_at IS NULL
      ORDER BY h.created_at DESC
      LIMIT 1`,
    [userId],
    client
  );
}

/**
 * Releases a hold. Conditional on it still being live, so the returned row proves
 * this caller won — two concurrent releases cannot both report success.
 */
async function releaseHold({ holdId, userId, reason = 'released' }, client = null) {
  return db.queryOne(
    `UPDATE slot_holds
        SET released_at = NOW(), release_reason = $3
      WHERE id = $1
        AND ($2::bigint IS NULL OR user_id = $2::bigint)
        AND released_at IS NULL AND consumed_at IS NULL
      RETURNING ${HOLD_COLUMNS.replace(/h\./g, '')}`,
    [holdId, userId, reason],
    client
  );
}

/** Marks a hold as converted into a booking. */
async function consumeHold(holdId, client = null) {
  return db.queryOne(
    `UPDATE slot_holds
        SET consumed_at = NOW()
      WHERE id = $1 AND consumed_at IS NULL AND released_at IS NULL
      RETURNING ${HOLD_COLUMNS.replace(/h\./g, '')}`,
    [holdId],
    client
  );
}

/* ── capacity management (operator) ────────────────────────────────────────── */

/** Creates slots for a lot, laid out 8 per row: A1..A8, B1..B8, … */
async function createSlots({ parkingAreaId, vehicleType, fromNumber, toNumber }, client = null) {
  return db.queryMany(
    `INSERT INTO parking_slots
       (parking_area_id, vehicle_type, code, row_label, position, slot_number, is_active)
     SELECT
       $1, $2,
       chr(65 + ((n - 1) / 8)) || (((n - 1) % 8) + 1)::text,
       chr(65 + ((n - 1) / 8)),
       ((n - 1) % 8) + 1,
       n,
       true
     FROM generate_series($3::int, $4::int) AS n
     ON CONFLICT (parking_area_id, vehicle_type, slot_number) DO NOTHING
     RETURNING id, code, slot_number`,
    [parkingAreaId, vehicleType, fromNumber, toNumber],
    client
  );
}

/**
 * Soft-closes slots. Deliberately never deletes.
 *
 * The old capacity update ran `DELETE FROM slots` and `DELETE FROM bookings` for the
 * whole lot, unarchived, whenever a slot count changed.
 */
async function closeSlots({ parkingAreaId, vehicleType, fromNumber, reason }, client = null) {
  return db.queryMany(
    `UPDATE parking_slots
        SET is_active = false, closed_reason = $4, updated_at = NOW()
      WHERE parking_area_id = $1 AND vehicle_type = $2 AND slot_number >= $3 AND is_active
      RETURNING id, code, slot_number`,
    [parkingAreaId, vehicleType, fromNumber, reason || 'capacity_reduced'],
    client
  );
}

async function reopenSlots({ parkingAreaId, vehicleType, toNumber }, client = null) {
  return db.queryMany(
    `UPDATE parking_slots
        SET is_active = true, closed_reason = NULL, updated_at = NOW()
      WHERE parking_area_id = $1 AND vehicle_type = $2 AND slot_number <= $3 AND NOT is_active
      RETURNING id, code, slot_number`,
    [parkingAreaId, vehicleType, toNumber],
    client
  );
}

/**
 * Future bookings that a capacity reduction would strand.
 *
 * Drives the impact preview the operator must review before confirming — the
 * mechanism that replaces silent deletion.
 */
async function bookingsAffectedByReduction(
  { parkingAreaId, vehicleType, fromNumber },
  client = null
) {
  return db.queryMany(
    `SELECT b.id, b.booking_code, b.entry_time, b.expected_exit_time, b.status,
            b.phone, ps.code AS slot_code, ps.slot_number
       FROM bookings b
       JOIN parking_slots ps ON ps.id = b.parking_slot_id
      WHERE ps.parking_area_id = $1
        AND ps.vehicle_type = $2
        AND ps.slot_number >= $3
        AND b.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
        AND b.expected_exit_time > NOW()
      ORDER BY b.entry_time`,
    [parkingAreaId, vehicleType, fromNumber],
    client
  );
}

async function countSlots({ parkingAreaId, vehicleType, client = null }) {
  const row = await db.queryOne(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_active)::int AS active,
            COALESCE(MAX(slot_number), 0)::int AS max_number
       FROM parking_slots
      WHERE parking_area_id = $1 AND vehicle_type = $2`,
    [parkingAreaId, vehicleType],
    client
  );
  return row || { total: 0, active: 0, max_number: 0 };
}

module.exports = {
  getLayout,
  getAvailabilitySummary,
  findById,
  findByNumber,
  isFreeForWindow,
  createHold,
  findHoldById,
  findActiveHoldForUser,
  releaseHold,
  consumeHold,
  createSlots,
  closeSlots,
  reopenSlots,
  bookingsAffectedByReduction,
  countSlots,
};
