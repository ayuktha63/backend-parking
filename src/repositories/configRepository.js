'use strict';

/**
 * Parking configuration reads and writes.
 *
 * Separate from operatorRepository because the concerns differ: that file answers
 * "what is happening now", this one answers "how is this lot set up". They have
 * different consistency requirements — an operations read may be a few seconds
 * stale and nobody is harmed; a configuration write that acts on stale state can
 * strand a paid reservation.
 *
 * Every write here is designed to be called inside a transaction that already holds
 * the parking area's advisory lock. None of them decides whether a change is safe —
 * that is parkingConfigService's job, and keeping the decision out of here means
 * there is exactly one place it is made.
 */

const db = require('../db');

/** States in which a booking still holds its slot. */
const OCCUPYING = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'];

/* ── reads ─────────────────────────────────────────────────────────────────── */

/**
 * The full configuration of one lot, in one round trip.
 *
 * Photos and amenities come back as aggregates rather than separate queries: the
 * configuration screen shows all of it at once, and three round trips to render one
 * screen is how a settings page ends up feeling slow.
 */
async function getConfiguration(parkingAreaId, client = null) {
  return db.queryOne(
    `SELECT
       pa.id, pa.name, pa.slug, pa.description, pa.instructions,
       pa.address_line, pa.locality, pa.city, pa.state, pa.postal_code, pa.landmark,
       pa.contact_phone, pa.lat, pa.lng,
       pa.base_car_price_paise, pa.base_bike_price_paise,
       pa.total_car_slots, pa.total_bike_slots,
       pa.is_active, pa.is_open_24_7, pa.timezone_offset_minutes,
       pa.max_duration_minutes, pa.rating_avg, pa.rating_count,
       pa.created_at, pa.updated_at,

       (SELECT COALESCE(array_agg(am.amenity_code ORDER BY am.amenity_code), '{}')
          FROM parking_amenities am WHERE am.parking_area_id = pa.id) AS amenity_codes,

       (SELECT COALESCE(json_agg(json_build_object(
                 'day_of_week', oh.day_of_week,
                 'opens_at', oh.opens_at,
                 'closes_at', oh.closes_at,
                 'closes_next_day', oh.closes_next_day
               ) ORDER BY oh.day_of_week), '[]'::json)
          FROM parking_opening_hours oh WHERE oh.parking_area_id = pa.id) AS opening_hours,

       (SELECT COUNT(*)::int FROM parking_photos ph
         WHERE ph.parking_area_id = pa.id) AS photo_count

     FROM parking_areas pa
     WHERE pa.id = $1`,
    [parkingAreaId],
    client
  );
}

/** Every amenity the platform supports. The one definition both apps read. */
async function listAmenityCatalogue(client = null) {
  return db.queryMany(
    `SELECT code, label, icon, sort_order FROM amenities ORDER BY sort_order, label`,
    [],
    client
  );
}

/**
 * Locks the parking area row for a configuration change.
 *
 * Returns `updated_at`, which is the optimistic-concurrency token: any write to the
 * lot bumps it via the `attach_updated_at` trigger, so a second operator's change
 * between preview and apply is detectable.
 */
async function lockForUpdate(parkingAreaId, client) {
  return db.queryOne(
    `SELECT id, updated_at, total_car_slots, total_bike_slots,
            base_car_price_paise, base_bike_price_paise, is_open_24_7
       FROM parking_areas WHERE id = $1 FOR UPDATE`,
    [parkingAreaId],
    client
  );
}

/* ── capacity ──────────────────────────────────────────────────────────────── */

/**
 * Everything the capacity impact calculation needs, in one query.
 *
 * The ids returned are the raw material of the impact hash: if any of these lists
 * changes between preview and apply, the operator reviewed something that is no
 * longer true.
 */
async function capacitySnapshot({ parkingAreaId, vehicleType, fromNumber, client = null }) {
  return db.queryOne(
    `WITH slots AS (
       SELECT id, slot_number, code, is_active
         FROM parking_slots
        WHERE parking_area_id = $1 AND vehicle_type = $2
     ),
     doomed AS (
       SELECT * FROM slots WHERE slot_number >= $3
     )
     SELECT
       (SELECT COUNT(*)::int FROM slots)                            AS total_slots,
       (SELECT COUNT(*)::int FROM slots WHERE is_active)            AS active_slots,
       (SELECT COALESCE(MAX(slot_number), 0)::int FROM slots)       AS max_slot_number,

       (SELECT COALESCE(array_agg(id ORDER BY id), '{}')
          FROM doomed WHERE is_active)                              AS closing_slot_ids,
       (SELECT COALESCE(array_agg(code ORDER BY slot_number), '{}')
          FROM doomed WHERE is_active)                              AS closing_slot_codes,

       -- Active bookings on the slots a reduction would close. These are the
       -- reservations that make a change unsafe.
       (SELECT COALESCE(array_agg(b.id ORDER BY b.id), '{}')
          FROM bookings b
          JOIN doomed d ON d.id = b.parking_slot_id
         WHERE b.status = ANY($4::text[])
           AND b.expected_exit_time > NOW())                        AS affected_booking_ids,

       (SELECT COALESCE(array_agg(h.id ORDER BY h.id), '{}')
          FROM slot_holds h
          JOIN doomed d ON d.id = h.parking_slot_id
         WHERE h.hold_expires_at > NOW()
           AND h.consumed_at IS NULL AND h.released_at IS NULL)      AS affected_hold_ids`,
    [parkingAreaId, vehicleType, fromNumber, OCCUPYING],
    client
  );
}

/**
 * The reservations a reduction would strand, with enough detail for the operator to
 * act on them.
 *
 * Deliberately excludes the customer's name and phone: this list exists so the
 * operator can see WHAT blocks the change, not to hand them a contact sheet. The
 * booking detail screen is where a specific customer is looked up.
 */
async function affectedBookings({ parkingAreaId, vehicleType, fromNumber, limit = 50, client = null }) {
  return db.queryMany(
    `SELECT b.id, b.booking_code, b.status, b.entry_time, b.expected_exit_time,
            b.vehicle_type, b.number_plate,
            ps.code AS slot_code, ps.slot_number
       FROM bookings b
       JOIN parking_slots ps ON ps.id = b.parking_slot_id
      WHERE ps.parking_area_id = $1
        AND ps.vehicle_type = $2
        AND ps.slot_number >= $3
        AND b.status = ANY($4::text[])
        AND b.expected_exit_time > NOW()
      ORDER BY b.entry_time
      LIMIT $5`,
    [parkingAreaId, vehicleType, fromNumber, OCCUPYING, limit],
    client
  );
}

/** Keeps the denormalised counter on `parking_areas` in step with real slot rows. */
async function setCapacityCounter({ parkingAreaId, vehicleType, total }, client) {
  const column = vehicleType === 'bike' ? 'total_bike_slots' : 'total_car_slots';
  return db.queryOne(
    `UPDATE parking_areas
        SET ${column} = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, total_car_slots, total_bike_slots, updated_at`,
    [parkingAreaId, total],
    client
  );
}

/* ── details ───────────────────────────────────────────────────────────────── */

/**
 * Updates the descriptive fields.
 *
 * Every parameter is COALESCEd, so an omitted field is left alone rather than
 * nulled. A settings form that PATCHes one field must not silently wipe the rest.
 */
async function updateDetails({ parkingAreaId, patch }, client = null) {
  return db.queryOne(
    `UPDATE parking_areas
        SET name          = COALESCE($2, name),
            description   = COALESCE($3, description),
            instructions  = COALESCE($4, instructions),
            address_line  = COALESCE($5, address_line),
            locality      = COALESCE($6, locality),
            city          = COALESCE($7, city),
            state         = COALESCE($8, state),
            postal_code   = COALESCE($9, postal_code),
            landmark      = COALESCE($10, landmark),
            contact_phone = COALESCE($11, contact_phone),
            updated_at    = NOW()
      WHERE id = $1
      RETURNING id, updated_at`,
    [
      parkingAreaId,
      patch.name ?? null,
      patch.description ?? null,
      patch.instructions ?? null,
      patch.addressLine ?? null,
      patch.locality ?? null,
      patch.city ?? null,
      patch.state ?? null,
      patch.postalCode ?? null,
      patch.landmark ?? null,
      patch.contactPhone ?? null,
    ],
    client
  );
}

/* ── pricing ───────────────────────────────────────────────────────────────── */

async function updatePricing({ parkingAreaId, carPaise, bikePaise }, client = null) {
  return db.queryOne(
    `UPDATE parking_areas
        SET base_car_price_paise  = COALESCE($2, base_car_price_paise),
            base_bike_price_paise = COALESCE($3, base_bike_price_paise),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, base_car_price_paise, base_bike_price_paise, updated_at`,
    [parkingAreaId, carPaise ?? null, bikePaise ?? null],
    client
  );
}

/**
 * Bookings whose price is already fixed.
 *
 * Used by the pricing preview to state, truthfully, how many existing reservations
 * are unaffected — because each carries a `pricing_snapshot` taken when it was made.
 */
async function countPriceLockedBookings({ parkingAreaId, client = null }) {
  const row = await db.queryOne(
    `SELECT COUNT(*)::int AS n
       FROM bookings
      WHERE parking_id = $1
        AND status = ANY($2::text[])
        AND expected_exit_time > NOW()`,
    [parkingAreaId, OCCUPYING],
    client
  );
  return row?.n ?? 0;
}

/* ── opening hours ─────────────────────────────────────────────────────────── */

/**
 * Replaces the whole weekly schedule.
 *
 * Delete-then-insert inside the caller's transaction, because a week is edited as a
 * unit: merging a partial update row by row would let a form that omits Sunday mean
 * either "unchanged" or "closed", and there is no way to tell which.
 *
 * A day with no row is closed. No rows at all means always open — the same
 * semantics `OPEN_NOW_EXPR` in parkingRepository already implements.
 */
async function replaceOpeningHours({ parkingAreaId, days }, client) {
  await db.query('DELETE FROM parking_opening_hours WHERE parking_area_id = $1', [parkingAreaId], client);

  if (!Array.isArray(days) || days.length === 0) return [];

  const values = [];
  const params = [parkingAreaId];
  let n = 1;

  for (const day of days) {
    values.push(`($1, $${n + 1}, $${n + 2}::time, $${n + 3}::time, $${n + 4})`);
    params.push(day.dayOfWeek, day.opensAt, day.closesAt, day.closesNextDay === true);
    n += 4;
  }

  return db.queryMany(
    `INSERT INTO parking_opening_hours
       (parking_area_id, day_of_week, opens_at, closes_at, closes_next_day)
     VALUES ${values.join(', ')}
     RETURNING day_of_week, opens_at, closes_at, closes_next_day`,
    params,
    client
  );
}

async function setOpen24x7({ parkingAreaId, isOpen24x7 }, client) {
  return db.queryOne(
    `UPDATE parking_areas SET is_open_24_7 = $2, updated_at = NOW()
      WHERE id = $1 RETURNING id, is_open_24_7, updated_at`,
    [parkingAreaId, isOpen24x7],
    client
  );
}

/* ── amenities ─────────────────────────────────────────────────────────────── */

/**
 * Replaces the amenity set.
 *
 * The FK to `amenities.code` (0007) means an unsupported code is rejected by the
 * database, not merely by a validator — so the customer's filter list and the
 * operator's editor cannot drift apart into two definitions.
 */
async function replaceAmenities({ parkingAreaId, codes }, client) {
  await db.query('DELETE FROM parking_amenities WHERE parking_area_id = $1', [parkingAreaId], client);

  if (!Array.isArray(codes) || codes.length === 0) return [];

  return db.queryMany(
    `INSERT INTO parking_amenities (parking_area_id, amenity_code)
     SELECT $1, code FROM unnest($2::text[]) AS code
     RETURNING amenity_code`,
    [parkingAreaId, codes],
    client
  );
}

/**
 * Whether a lot is open for an entire window.
 *
 * Evaluates the SAME rules as `OPEN_NOW_EXPR` in parkingRepository — the lot's own
 * `timezone_offset_minutes`, `closes_next_day` for overnight lots, no rows meaning
 * always open — but over a requested window rather than the current instant.
 *
 * Checks the start and the end. A window that begins and ends inside opening hours
 * but spans a closure between them is rare enough (it needs a lot that closes and
 * reopens the same day, which this schema cannot express — one row per weekday)
 * that the two endpoints are sufficient here.
 */
async function isOpenForWindow({ parkingAreaId, startAt, endAt, client = null }) {
  const row = await db.queryOne(
    `WITH area AS (
       SELECT id, is_open_24_7, timezone_offset_minutes FROM parking_areas WHERE id = $1
     ),
     has_hours AS (
       SELECT EXISTS (
         SELECT 1 FROM parking_opening_hours WHERE parking_area_id = $1
       ) AS any_rows
     ),
     checks AS (
       -- Both endpoints of the window, shifted into the lot's own local time.
       SELECT (instant + ((SELECT timezone_offset_minutes FROM area) || ' minutes')::interval)
                AS local_instant
         FROM (VALUES ($2::timestamptz), ($3::timestamptz)) AS v(instant)
     )
     SELECT
       (SELECT is_open_24_7 FROM area)  AS is_open_24_7,
       (SELECT any_rows FROM has_hours) AS has_hours,
       bool_and(
         EXISTS (
           SELECT 1 FROM parking_opening_hours oh
            WHERE oh.parking_area_id = $1
              AND oh.day_of_week = EXTRACT(DOW FROM c.local_instant)::int
              AND (
                (NOT oh.closes_next_day
                   AND c.local_instant::time BETWEEN oh.opens_at AND oh.closes_at)
                OR
                (oh.closes_next_day
                   AND (c.local_instant::time >= oh.opens_at
                        OR c.local_instant::time <= oh.closes_at))
              )
         )
       ) AS open_at_both_ends
     FROM checks c`,
    [parkingAreaId, startAt, endAt],
    client
  );

  if (!row) return { open: false, reason: 'PARKING_NOT_FOUND' };
  // 24/7, or no schedule configured at all, means always open — the same fallback
  // the discovery query applies, so the two cannot disagree.
  if (row.is_open_24_7 === true) return { open: true };
  if (row.has_hours !== true) return { open: true };

  return row.open_at_both_ends === true ? { open: true } : { open: false, reason: 'CLOSED' };
}

/**
 * The lot's schedule in words, for the refusal message. An operator who closes
 * Sundays should produce "This parking area is closed on Sunday", not a generic no.
 */
async function openingHoursFor({ parkingAreaId, dayOfWeek, client = null }) {
  return db.queryOne(
    `SELECT opens_at, closes_at, closes_next_day
       FROM parking_opening_hours
      WHERE parking_area_id = $1 AND day_of_week = $2`,
    [parkingAreaId, dayOfWeek],
    client
  );
}

/* ── slot-level ────────────────────────────────────────────────────────────── */

/** Active bookings on one specific slot. Drives the "cannot close" explanation. */
async function bookingsOnSlot({ slotId, limit = 20, client = null }) {
  return db.queryMany(
    `SELECT b.id, b.booking_code, b.status, b.entry_time, b.expected_exit_time,
            b.number_plate
       FROM bookings b
      WHERE b.parking_slot_id = $1
        AND b.status = ANY($2::text[])
        AND b.expected_exit_time > NOW()
      ORDER BY b.entry_time
      LIMIT $3`,
    [slotId, OCCUPYING, limit],
    client
  );
}

/**
 * The configuration view of the layout.
 *
 * Distinct from `operatorRepository.liveGrid`, which answers "what is happening
 * now". This answers "how is this lot set up": every slot regardless of current
 * activity, with the count of future reservations that constrain changing it.
 */
async function configurationGrid({ parkingAreaId, vehicleType = null, client = null }) {
  return db.queryMany(
    `SELECT
       ps.id, ps.code, ps.row_label, ps.position, ps.slot_number,
       ps.slot_class, ps.vehicle_type, ps.is_active, ps.closed_reason,
       (SELECT COUNT(*)::int FROM bookings b
         WHERE b.parking_slot_id = ps.id
           AND b.status = ANY($3::text[])
           AND b.expected_exit_time > NOW())            AS upcoming_bookings,
       EXISTS (SELECT 1 FROM slot_holds h
                WHERE h.parking_slot_id = ps.id
                  AND h.hold_expires_at > NOW()
                  AND h.consumed_at IS NULL AND h.released_at IS NULL) AS is_held
     FROM parking_slots ps
     WHERE ps.parking_area_id = $1
       AND ($2::text IS NULL OR ps.vehicle_type = $2)
     ORDER BY ps.vehicle_type, ps.row_label, ps.position, ps.slot_number`,
    [parkingAreaId, vehicleType, OCCUPYING],
    client
  );
}

module.exports = {
  OCCUPYING,
  getConfiguration,
  listAmenityCatalogue,
  lockForUpdate,
  capacitySnapshot,
  affectedBookings,
  setCapacityCounter,
  updateDetails,
  updatePricing,
  countPriceLockedBookings,
  replaceOpeningHours,
  setOpen24x7,
  replaceAmenities,
  isOpenForWindow,
  openingHoursFor,
  bookingsOnSlot,
  configurationGrid,
};
