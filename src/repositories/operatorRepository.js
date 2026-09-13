'use strict';

/**
 * Operator-side reads.
 *
 * Separate from bookingRepository for one reason that matters: what an operator may
 * see is not what a customer may see. A customer reads their own booking in full;
 * an operator reads *other people's* bookings, scoped to a lot they own. Keeping
 * those queries in different files makes the difference visible rather than
 * incidental.
 *
 * Every query here is aggregate-first. The dashboard must never fetch a booking
 * list in order to count one — a lot with three years of history would then get
 * slower every day it operates.
 */

const db = require('../db');

/** States in which a booking still occupies its slot. */
const OCCUPYING = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'];

/* ── dashboard ─────────────────────────────────────────────────────────────── */

/**
 * Everything the dashboard shows, in ONE round trip.
 *
 * "Today" is the lot's local day, not the server's UTC day — a lot closing at 23:00
 * IST would otherwise have its takings split across two calendar days. The offset
 * comes from `parking_areas.timezone_offset_minutes`, added in 0004 for exactly this.
 */
async function dashboardSummary({ parkingAreaId, arrivalWindowMinutes = 30, client = null }) {
  return db.queryOne(
    `WITH area AS (
       SELECT id, timezone_offset_minutes, total_car_slots, total_bike_slots
         FROM parking_areas WHERE id = $1
     ),
     day AS (
       SELECT
         -- Midnight local, expressed as an instant.
         date_trunc(
           'day',
           NOW() + ((SELECT timezone_offset_minutes FROM area) || ' minutes')::interval
         ) - ((SELECT timezone_offset_minutes FROM area) || ' minutes')::interval AS started_at
     ),
     slots AS (
       SELECT
         COUNT(*) FILTER (WHERE is_active)::int      AS total,
         COUNT(*) FILTER (WHERE NOT is_active)::int  AS out_of_service,
         COUNT(*) FILTER (WHERE is_active AND vehicle_type = 'car')::int  AS car_total,
         COUNT(*) FILTER (WHERE is_active AND vehicle_type = 'bike')::int AS bike_total
       FROM parking_slots WHERE parking_area_id = $1
     ),
     live AS (
       SELECT
         COUNT(DISTINCT b.parking_slot_id) FILTER (WHERE b.status = 'CHECKED_IN')::int AS occupied,
         COUNT(DISTINCT b.parking_slot_id) FILTER (
           WHERE b.status = 'CONFIRMED'
             AND b.entry_time <= NOW()
             AND b.expected_exit_time > NOW()
         )::int AS reserved_now,
         COUNT(*) FILTER (
           WHERE b.status = 'CONFIRMED'
             AND b.entry_time > NOW()
             AND b.entry_time <= NOW() + ($2 || ' minutes')::interval
         )::int AS arriving_soon,
         COUNT(*) FILTER (
           WHERE b.status = 'CONFIRMED'
             AND b.entry_time <= NOW()
             AND b.entry_time > NOW() - interval '30 minutes'
         )::int AS arriving_now,
         COUNT(*) FILTER (
           WHERE b.status = 'CHECKED_IN'
             AND b.expected_exit_time < NOW()
         )::int AS overstaying
       FROM bookings b
       WHERE b.parking_id = $1
         AND b.status = ANY($3::text[])
     ),
     held AS (
       SELECT COUNT(DISTINCT h.parking_slot_id)::int AS held_slots
         FROM slot_holds h
         JOIN parking_slots ps ON ps.id = h.parking_slot_id
        WHERE ps.parking_area_id = $1
          AND h.hold_expires_at > NOW()
          AND h.consumed_at IS NULL AND h.released_at IS NULL
     ),
     today AS (
       SELECT
         COUNT(*) FILTER (WHERE b.created_at >= (SELECT started_at FROM day))::int AS bookings_made,
         COUNT(*) FILTER (
           WHERE b.checked_in_at >= (SELECT started_at FROM day)
         )::int AS check_ins,
         COUNT(*) FILTER (
           WHERE b.completed_at >= (SELECT started_at FROM day)
         )::int AS completions,
         COUNT(*) FILTER (
           WHERE b.status = 'NO_SHOW' AND b.updated_at >= (SELECT started_at FROM day)
         )::int AS no_shows,
         COUNT(*) FILTER (
           WHERE b.status = 'CANCELLED' AND b.cancelled_at >= (SELECT started_at FROM day)
         )::int AS cancellations,
         -- Revenue counts only money actually settled. A PENDING_PAYMENT booking is
         -- not takings, and the old dashboard would have counted it.
         COALESCE(SUM(
           CASE WHEN b.completed_at >= (SELECT started_at FROM day)
                 AND EXISTS (SELECT 1 FROM payments p
                              WHERE p.booking_id = b.id AND p.status = 'PAID')
                THEN COALESCE(b.final_amount_paise, b.amount_paise, 0)
                ELSE 0 END
         ), 0)::bigint AS revenue_paise
       FROM bookings b
       WHERE b.parking_id = $1
     )
     SELECT
       (SELECT total FROM slots)           AS slots_total,
       (SELECT out_of_service FROM slots)  AS slots_out_of_service,
       (SELECT car_total FROM slots)       AS slots_car,
       (SELECT bike_total FROM slots)      AS slots_bike,
       (SELECT occupied FROM live)         AS occupied,
       (SELECT reserved_now FROM live)     AS reserved_now,
       (SELECT arriving_now FROM live)     AS arriving_now,
       (SELECT arriving_soon FROM live)    AS arriving_soon,
       (SELECT overstaying FROM live)      AS overstaying,
       (SELECT held_slots FROM held)       AS held,
       (SELECT bookings_made FROM today)   AS today_bookings,
       (SELECT check_ins FROM today)       AS today_check_ins,
       (SELECT completions FROM today)     AS today_completions,
       (SELECT no_shows FROM today)        AS today_no_shows,
       (SELECT cancellations FROM today)   AS today_cancellations,
       (SELECT revenue_paise FROM today)   AS today_revenue_paise,
       (SELECT started_at FROM day)        AS day_started_at`,
    [parkingAreaId, arrivalWindowMinutes, OCCUPYING],
    client
  );
}

/* ── arrivals ──────────────────────────────────────────────────────────────── */

const ARRIVAL_COLUMNS = `
  b.id, b.booking_code, b.status, b.entry_time, b.expected_exit_time,
  b.duration_minutes, b.vehicle_type, b.number_plate, b.phone,
  b.amount_paise, b.checked_in_at, b.created_at,
  ps.code AS slot_code, ps.row_label AS slot_row, ps.position AS slot_position,
  ps.id AS slot_id, ps.slot_class,
  u.name AS customer_name,
  pay.status AS payment_status
`;

const ARRIVAL_JOINS = `
  FROM bookings b
  LEFT JOIN parking_slots ps ON ps.id = b.parking_slot_id
  LEFT JOIN users u ON u.id = b.user_id
  LEFT JOIN LATERAL (
    SELECT p.status FROM payments p
     WHERE p.booking_id = b.id
     ORDER BY (p.status = 'PAID') DESC, p.created_at DESC
     LIMIT 1
  ) pay ON TRUE
`;

/**
 * Bookings due at a lot within a window.
 *
 * Ordered by entry time so the operator reads the board top-down and the person in
 * front of them is near the top. Bounded by `limit` — an arrivals board is a
 * working view, not an export.
 */
async function arrivals({
  parkingAreaId,
  fromTime,
  toTime,
  statuses = ['CONFIRMED', 'CHECKED_IN', 'PENDING_PAYMENT'],
  limit = 100,
  client = null,
}) {
  return db.queryMany(
    `SELECT ${ARRIVAL_COLUMNS} ${ARRIVAL_JOINS}
      WHERE b.parking_id = $1
        AND b.status = ANY($2::text[])
        AND b.entry_time >= $3
        AND b.entry_time <= $4
      ORDER BY b.entry_time ASC
      LIMIT $5`,
    [parkingAreaId, statuses, fromTime, toTime, limit],
    client
  );
}

/**
 * Bookings that should have arrived and did not.
 *
 * Still CONFIRMED with an entry time comfortably in the past: the operator needs to
 * see these to decide whether to release the slot or wait.
 */
async function overdueArrivals({ parkingAreaId, graceMinutes = 15, limit = 50, client = null }) {
  return db.queryMany(
    `SELECT ${ARRIVAL_COLUMNS} ${ARRIVAL_JOINS}
      WHERE b.parking_id = $1
        AND b.status = 'CONFIRMED'
        AND b.entry_time < NOW() - ($2 || ' minutes')::interval
        AND b.expected_exit_time > NOW()
      ORDER BY b.entry_time ASC
      LIMIT $3`,
    [parkingAreaId, graceMinutes, limit],
    client
  );
}

/* ── booking lookup ────────────────────────────────────────────────────────── */

/**
 * Finds a booking by the code the driver reads out.
 *
 * Scoped to the lots this owner holds — passed as an array, because the data model
 * allows an owner more than one. A code for someone else's lot returns nothing,
 * which is the same answer as a code that does not exist: an operator must not be
 * able to enumerate the platform's bookings by guessing codes.
 *
 * `upper(b.booking_code)` matches the functional index added in 0010.
 */
async function findByCodeForOwner({ code, parkingAreaIds, client = null }) {
  return db.queryOne(
    `SELECT ${ARRIVAL_COLUMNS}, b.parking_id, b.user_id, b.cancelled_at,
            b.completed_at, b.final_amount_paise, b.cancellation_reason,
            pa.name AS parking_name, pa.instructions AS parking_instructions
       FROM bookings b
       LEFT JOIN parking_slots ps ON ps.id = b.parking_slot_id
       LEFT JOIN users u          ON u.id  = b.user_id
       LEFT JOIN parking_areas pa ON pa.id = b.parking_id
       LEFT JOIN LATERAL (
         SELECT p.status FROM payments p
          WHERE p.booking_id = b.id
          ORDER BY (p.status = 'PAID') DESC, p.created_at DESC
          LIMIT 1
       ) pay ON TRUE
      WHERE upper(b.booking_code) = upper($1)
        AND b.parking_id = ANY($2::bigint[])
      LIMIT 1`,
    [String(code).trim(), parkingAreaIds],
    client
  );
}

/** Same, by number plate — for a driver who has lost their code. */
async function findByPlateForOwner({ plate, parkingAreaIds, limit = 5, client = null }) {
  const normalised = String(plate).toUpperCase().replace(/\s+/g, '');

  return db.queryMany(
    `SELECT ${ARRIVAL_COLUMNS}, b.parking_id
       ${ARRIVAL_JOINS}
      WHERE upper(replace(b.number_plate, ' ', '')) = $1
        AND b.parking_id = ANY($2::bigint[])
        AND b.status = ANY($3::text[])
      ORDER BY b.entry_time DESC
      LIMIT $4`,
    [normalised, parkingAreaIds, OCCUPYING, limit],
    client
  );
}

/* ── live grid ─────────────────────────────────────────────────────────────── */

/**
 * The slot layout with operational context.
 *
 * Distinct from `slotRepository.getLayout`, which serves the customer and
 * deliberately says only *that* a slot is taken. The operator needs to know *who*
 * is in it — which booking, which vehicle, since when — because that is the job.
 *
 * Status here is richer than the customer's four states: a slot reserved for later
 * today is operationally different from one with a car in it, and collapsing them
 * to "booked" would leave the operator unable to tell.
 */
async function liveGrid({ parkingAreaId, vehicleType, client = null }) {
  return db.queryMany(
    `SELECT
       ps.id, ps.code, ps.row_label, ps.position, ps.slot_number,
       ps.slot_class, ps.is_active, ps.closed_reason, ps.vehicle_type,

       current.id            AS booking_id,
       current.booking_code  AS booking_code,
       current.status        AS booking_status,
       current.number_plate  AS number_plate,
       current.entry_time    AS entry_time,
       current.expected_exit_time AS expected_exit_time,
       current.checked_in_at AS checked_in_at,

       hold.id               AS hold_id,
       hold.hold_expires_at  AS hold_expires_at,

       CASE
         WHEN NOT ps.is_active                      THEN 'out_of_service'
         WHEN current.status = 'CHECKED_IN'         THEN 'occupied'
         WHEN current.status = 'CONFIRMED'          THEN 'reserved'
         WHEN current.status = 'PENDING_PAYMENT'    THEN 'pending_payment'
         WHEN hold.id IS NOT NULL                   THEN 'held'
         ELSE 'available'
       END AS state

     FROM parking_slots ps

     -- The booking that matters right now: one in progress, else the next one
     -- starting within the hour. Anything further out is not an operational
     -- concern and would make every slot look busy.
     LEFT JOIN LATERAL (
       SELECT b.id, b.booking_code, b.status, b.number_plate,
              b.entry_time, b.expected_exit_time, b.checked_in_at
         FROM bookings b
        WHERE b.parking_slot_id = ps.id
          AND b.status = ANY($3::text[])
          AND b.expected_exit_time > NOW()
          AND b.entry_time <= NOW() + interval '1 hour'
        ORDER BY (b.status = 'CHECKED_IN') DESC, b.entry_time ASC
        LIMIT 1
     ) current ON TRUE

     LEFT JOIN LATERAL (
       SELECT h.id, h.hold_expires_at
         FROM slot_holds h
        WHERE h.parking_slot_id = ps.id
          AND h.hold_expires_at > NOW()
          AND h.consumed_at IS NULL AND h.released_at IS NULL
        ORDER BY h.created_at DESC
        LIMIT 1
     ) hold ON TRUE

     WHERE ps.parking_area_id = $1
       AND ($2::text IS NULL OR ps.vehicle_type = $2)
     ORDER BY ps.vehicle_type, ps.row_label ASC, ps.position ASC, ps.slot_number ASC`,
    [parkingAreaId, vehicleType ?? null, OCCUPYING],
    client
  );
}

/** One slot, with the same operational context. Drives the slot detail sheet. */
async function slotDetail({ slotId, client = null }) {
  const rows = await db.queryMany(
    `SELECT ps.parking_area_id, ps.vehicle_type FROM parking_slots ps WHERE ps.id = $1`,
    [slotId],
    client
  );
  if (rows.length === 0) return null;

  const all = await liveGrid({
    parkingAreaId: rows[0].parking_area_id,
    vehicleType: rows[0].vehicle_type,
    client,
  });
  return all.find((s) => Number(s.id) === Number(slotId)) ?? null;
}

/* ── operator booking list ─────────────────────────────────────────────────── */

/**
 * The operator's bookings screen.
 *
 * `search` matches a booking code, a plate, or a phone — the three things a driver
 * standing at the barrier can actually supply.
 */
async function listBookings({
  parkingAreaIds,
  statuses,
  fromTime = null,
  toTime = null,
  search = null,
  limit = 30,
  offset = 0,
  client = null,
}) {
  const term = search ? String(search).trim() : null;

  return db.queryMany(
    `SELECT ${ARRIVAL_COLUMNS}, b.parking_id, b.final_amount_paise,
            b.completed_at, b.cancelled_at,
            pa.name AS parking_name
       FROM bookings b
       LEFT JOIN parking_slots ps ON ps.id = b.parking_slot_id
       LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN parking_areas pa ON pa.id = b.parking_id
       LEFT JOIN LATERAL (
         SELECT p.status FROM payments p
          WHERE p.booking_id = b.id
          ORDER BY (p.status = 'PAID') DESC, p.created_at DESC
          LIMIT 1
       ) pay ON TRUE
      WHERE b.parking_id = ANY($1::bigint[])
        AND ($2::text[] IS NULL OR b.status = ANY($2::text[]))
        AND ($3::timestamptz IS NULL OR b.entry_time >= $3)
        AND ($4::timestamptz IS NULL OR b.entry_time <= $4)
        AND (
          $5::text IS NULL
          OR upper(b.booking_code) LIKE upper($5) || '%'
          OR upper(replace(COALESCE(b.number_plate, ''), ' ', '')) LIKE
             '%' || upper(replace($5, ' ', '')) || '%'
          OR COALESCE(b.phone, '') LIKE '%' || $5 || '%'
        )
      ORDER BY b.entry_time DESC
      LIMIT $6 OFFSET $7`,
    [parkingAreaIds, statuses ?? null, fromTime, toTime, term, limit + 1, offset],
    client
  );
}

/** Counts per operator filter, in one query, for the tab badges. */
async function bookingCounts({ parkingAreaIds, dayStartedAt, client = null }) {
  const row = await db.queryOne(
    `SELECT
       COUNT(*) FILTER (
         WHERE entry_time >= $2 AND entry_time < $2 + interval '1 day'
       )::int AS today,
       COUNT(*) FILTER (
         WHERE status = 'CONFIRMED' AND entry_time > NOW()
       )::int AS upcoming,
       COUNT(*) FILTER (WHERE status = 'CHECKED_IN')::int AS active,
       COUNT(*) FILTER (WHERE status IN ('COMPLETED','NO_SHOW'))::int AS completed,
       COUNT(*) FILTER (WHERE status IN ('CANCELLED','EXPIRED'))::int AS cancelled
     FROM bookings
     WHERE parking_id = ANY($1::bigint[])`,
    [parkingAreaIds, dayStartedAt],
    client
  );
  return row || { today: 0, upcoming: 0, active: 0, completed: 0, cancelled: 0 };
}

/* ── audit ─────────────────────────────────────────────────────────────────── */

/** Appends a configuration-change record. Append-only by design. */
async function recordAudit(
  { parkingAreaId, ownerId, eventType, detail = {} },
  client = null
) {
  return db.queryOne(
    `INSERT INTO parking_audit_events (parking_area_id, owner_id, event_type, detail)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [parkingAreaId, ownerId, eventType, JSON.stringify(detail || {})],
    client
  );
}

async function listAudit({ parkingAreaId, limit = 50, client = null }) {
  return db.queryMany(
    `SELECT id, event_type, detail, created_at, owner_id
       FROM parking_audit_events
      WHERE parking_area_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [parkingAreaId, limit],
    client
  );
}

module.exports = {
  OCCUPYING,
  dashboardSummary,
  arrivals,
  overdueArrivals,
  findByCodeForOwner,
  findByPlateForOwner,
  liveGrid,
  slotDetail,
  listBookings,
  bookingCounts,
  recordAudit,
  listAudit,
};
