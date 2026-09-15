'use strict';

/**
 * The booking lifecycle, against a real database.
 *
 * Every test here corresponds to a defect that only appeared once real SQL ran.
 * The unit suite passed all 117 of its assertions while `createHold` →
 * `createFromHold` could not complete a single booking.
 *
 * Requires DATABASE_URL with migrations applied. See database.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skip = HAS_DB ? false : 'DATABASE_URL is not set — no database to test against';

if (!HAS_DB) {
  console.warn('\n  ⚠ tests/contract/booking-lifecycle.test.js SKIPPED — DATABASE_URL not set\n');
}

const db = HAS_DB ? require('../../src/db') : null;

test.after(async () => {
  if (HAS_DB) await db.close();
});

/** A lot with slots, an owner and a customer. Fresh per test. */
async function fixture() {
  const stamp = Date.now() % 100000;
  const owner = await db.queryOne(
    `INSERT INTO owners (phone, name) VALUES ($1, 'Lifecycle Owner') RETURNING id`,
    [`98${String(stamp).padStart(8, '0')}`]
  );
  const user = await db.queryOne(
    `INSERT INTO users (phone, name) VALUES ($1, 'Lifecycle User') RETURNING id`,
    [`97${String(stamp).padStart(8, '0')}`]
  );
  const area = await db.queryOne(
    `INSERT INTO parking_areas (name, owner_id, base_car_price_paise, total_car_slots,
                                is_active, is_open_24_7, timezone_offset_minutes)
     VALUES ($1, $2, 4000, 3, true, true, 330) RETURNING *`,
    [`Lifecycle Lot ${stamp}`, owner.id]
  );
  const slots = await db.queryMany(
    `INSERT INTO parking_slots (parking_area_id, vehicle_type, code, row_label, position, slot_number)
     SELECT $1, 'car', 'L'||n, 'L', n, n FROM generate_series(1,3) n RETURNING id, slot_number, code`,
    [area.id]
  );
  return { ownerId: owner.id, userId: user.id, area, slots };
}

/* ── booking creation ──────────────────────────────────────────────────────── */

test('a hold can actually become a booking', { skip }, async () => {
  // REGRESSION: bookingRepository.create named the column `amount`, which
  // migration 0008 renames to `amount_legacy_rupees`. Every booking attempt failed
  // with 42703 "column does not exist" — on a schema where every static check,
  // including the SQL placeholder counter, passed.
  const bookingService = require('../../src/services/bookingService');
  const f = await fixture();

  const hold = await bookingService.createHold({
    userId: f.userId,
    parkingAreaId: f.area.id,
    slotId: f.slots[0].id,
    startAt: new Date(Date.now() + 3600_000),
    durationMinutes: 60,
  });

  assert.ok(hold.id, 'a hold was created');
  assert.equal(typeof hold.id, 'number', 'ids must be numbers, not strings');

  const { booking, created } = await bookingService.createFromHold({
    userId: f.userId,
    holdId: hold.id,
    numberPlate: 'KA01TEST01',
    idempotencyKey: `lifecycle-${Date.now()}`,
  });

  assert.equal(created, true);
  assert.equal(booking.status, 'PENDING_PAYMENT');
  assert.match(booking.code, /^PQX-[2-9A-HJ-NP-Z]{6}$/);
  assert.equal(booking.amount.reserved_paise, 4000);
  assert.equal(typeof booking.id, 'number');
});

test('an idempotency key returns the original booking, never a second one', { skip }, async () => {
  const bookingService = require('../../src/services/bookingService');
  const f = await fixture();
  const key = `idem-${Date.now()}`;

  const hold = await bookingService.createHold({
    userId: f.userId, parkingAreaId: f.area.id, slotId: f.slots[0].id,
    startAt: new Date(Date.now() + 3600_000), durationMinutes: 60,
  });

  const first = await bookingService.createFromHold({
    userId: f.userId, holdId: hold.id, numberPlate: 'KA01TEST02', idempotencyKey: key,
  });
  const second = await bookingService.createFromHold({
    userId: f.userId, holdId: hold.id, numberPlate: 'KA01TEST02', idempotencyKey: key,
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false, 'the retry must not create a booking');
  assert.equal(second.booking.id, first.booking.id);

  const count = await db.queryOne(
    'SELECT COUNT(*)::int AS n FROM bookings WHERE idempotency_key = $1', [key]
  );
  assert.equal(count.n, 1, 'exactly one row in the database');
});

test('holding a closed slot is refused', { skip }, async () => {
  const bookingService = require('../../src/services/bookingService');
  const f = await fixture();
  await db.query('UPDATE parking_slots SET is_active = false WHERE id = $1', [f.slots[1].id]);

  await assert.rejects(
    () => bookingService.createHold({
      userId: f.userId, parkingAreaId: f.area.id, slotId: f.slots[1].id,
      startAt: new Date(Date.now() + 3600_000), durationMinutes: 60,
    }),
    (err) => { assert.equal(err.code, 'SLOT_CLOSED'); return true; }
  );
});

test('holding outside opening hours is refused, naming the day', { skip }, async () => {
  // REGRESSION: opening hours were consulted ONLY by the discovery filter. A
  // customer deep-linking past discovery could hold a slot on a day the operator
  // had marked closed.
  const bookingService = require('../../src/services/bookingService');
  const f = await fixture();

  await db.query('UPDATE parking_areas SET is_open_24_7 = false WHERE id = $1', [f.area.id]);
  // A schedule that cannot contain the requested window on any day.
  await db.query(
    `INSERT INTO parking_opening_hours (parking_area_id, day_of_week, opens_at, closes_at)
     SELECT $1, d, '03:00'::time, '03:15'::time FROM generate_series(0,6) d`,
    [f.area.id]
  );

  await assert.rejects(
    () => bookingService.createHold({
      userId: f.userId, parkingAreaId: f.area.id, slotId: f.slots[0].id,
      startAt: new Date(Date.now() + 3600_000), durationMinutes: 60,
    }),
    (err) => {
      assert.equal(err.code, 'PARKING_CLOSED');
      assert.match(err.message, /closed|open/i);
      return true;
    }
  );
});

/* ── configuration safety ──────────────────────────────────────────────────── */

test('a refused capacity reduction is still recorded in the audit log', { skip }, async () => {
  // REGRESSION: recordAudit ran inside the transaction whose rollback WAS the
  // refusal, so every refusal erased its own audit row. An audit trail that only
  // survives successes cannot demonstrate that anything was ever protected.
  const parkingConfigService = require('../../src/services/parkingConfigService');
  const bookingService = require('../../src/services/bookingService');
  const f = await fixture();

  // Occupy the highest slot so a reduction to 1 would strand it.
  const hold = await bookingService.createHold({
    userId: f.userId, parkingAreaId: f.area.id, slotId: f.slots[2].id,
    startAt: new Date(Date.now() + 3600_000), durationMinutes: 60,
  });
  await bookingService.createFromHold({
    userId: f.userId, holdId: hold.id, numberPlate: 'KA01TEST03',
    idempotencyKey: `audit-${Date.now()}`,
  });

  const preview = await parkingConfigService.previewCapacityChange({
    ownerId: f.ownerId, parkingAreaId: f.area.id, vehicleType: 'car', target: 1,
  });

  assert.equal(preview.can_apply, false);
  assert.ok(preview.affected_bookings.length > 0, 'the booking must be reported');

  const before = await db.queryOne(
    `SELECT COUNT(*)::int AS n FROM parking_audit_events
      WHERE parking_area_id = $1 AND event_type = 'capacity_reduction_blocked'`,
    [f.area.id]
  );

  await assert.rejects(
    () => parkingConfigService.applyCapacityChange({
      ownerId: f.ownerId, parkingAreaId: f.area.id, vehicleType: 'car',
      target: 1, impactHash: preview.impact_hash,
    }),
    (err) => { assert.equal(err.code, 'CAPACITY_REDUCTION_BLOCKED'); return true; }
  );

  const after = await db.queryOne(
    `SELECT COUNT(*)::int AS n FROM parking_audit_events
      WHERE parking_area_id = $1 AND event_type = 'capacity_reduction_blocked'`,
    [f.area.id]
  );
  assert.equal(after.n, before.n + 1, 'the refusal must survive the rollback that caused it');

  // And nothing was partially applied.
  const active = await db.queryOne(
    `SELECT COUNT(*)::int AS n FROM parking_slots
      WHERE parking_area_id = $1 AND vehicle_type = 'car' AND is_active`,
    [f.area.id]
  );
  assert.equal(active.n, 3, 'no slot may be closed by a refused reduction');
});

test('a stale impact hash is refused and changes nothing', { skip }, async () => {
  const parkingConfigService = require('../../src/services/parkingConfigService');
  const bookingService = require('../../src/services/bookingService');
  const f = await fixture();

  const preview = await parkingConfigService.previewCapacityChange({
    ownerId: f.ownerId, parkingAreaId: f.area.id, vehicleType: 'car', target: 1,
  });
  assert.equal(preview.can_apply, true, 'nothing blocks it at preview time');

  // The world moves: a customer takes one of the slots that would be closed.
  await bookingService.createHold({
    userId: f.userId, parkingAreaId: f.area.id, slotId: f.slots[2].id,
    startAt: new Date(Date.now() + 3600_000), durationMinutes: 60,
  });

  await assert.rejects(
    () => parkingConfigService.applyCapacityChange({
      ownerId: f.ownerId, parkingAreaId: f.area.id, vehicleType: 'car',
      target: 1, impactHash: preview.impact_hash,
    }),
    (err) => { assert.equal(err.code, 'IMPACT_HASH_MISMATCH'); return true; }
  );

  const active = await db.queryOne(
    `SELECT COUNT(*)::int AS n FROM parking_slots
      WHERE parking_area_id = $1 AND vehicle_type = 'car' AND is_active`,
    [f.area.id]
  );
  assert.equal(active.n, 3, 'a refused apply must leave no partial configuration');
});

test('a successful capacity reduction closes slots without deleting anything', { skip }, async () => {
  const parkingConfigService = require('../../src/services/parkingConfigService');
  const f = await fixture();

  const preview = await parkingConfigService.previewCapacityChange({
    ownerId: f.ownerId, parkingAreaId: f.area.id, vehicleType: 'car', target: 1,
  });
  const result = await parkingConfigService.applyCapacityChange({
    ownerId: f.ownerId, parkingAreaId: f.area.id, vehicleType: 'car',
    target: 1, impactHash: preview.impact_hash,
  });

  assert.equal(result.applied, true);
  assert.equal(result.closed.length, 2);

  const rows = await db.queryOne(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_active)::int AS active
       FROM parking_slots WHERE parking_area_id = $1 AND vehicle_type = 'car'`,
    [f.area.id]
  );
  // Soft-closed, never deleted: the rows a past booking points at must survive.
  assert.equal(rows.total, 3, 'slot rows are retained');
  assert.equal(rows.active, 1, 'only one remains bookable');
});
