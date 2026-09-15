'use strict';

/**
 * Database behaviour, against a real PostgreSQL.
 *
 * These are the tests the unit suite structurally cannot be: they execute SQL.
 * Every one of them exists because a static check passed while the real statement
 * would have failed — or, worse, would have silently succeeded with a wrong value.
 *
 * Requires DATABASE_URL pointing at a DISPOSABLE database with migrations applied:
 *
 *   createdb parqx_test
 *   DATABASE_URL=postgres://…/parqx_test npm run migrate
 *   DATABASE_URL=postgres://…/parqx_test npm run test:contract
 *
 * Skipped, loudly, when DATABASE_URL is absent. Never silently passed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skip = HAS_DB ? false : 'DATABASE_URL is not set — no database to test against';

if (!HAS_DB) {
  // Visible in the output rather than a silent zero-test pass.
  console.warn('\n  ⚠ tests/contract/database.test.js SKIPPED — DATABASE_URL not set\n');
}

const db = HAS_DB ? require('../../src/db') : null;

test.after(async () => {
  if (HAS_DB) await db.close();
});

/* ── type serialisation ────────────────────────────────────────────────────── */

test('bigint columns arrive as JavaScript numbers, not strings', { skip }, async () => {
  // `pg` returns int8 as a STRING by default. Every id in this schema is bigserial,
  // and every Flutter model parses ids with `(json['id'] as num?)` — which yields
  // null for a String and falls back to 0. Before this was fixed, every parking
  // card, booking and slot reached both apps with id 0.
  const row = await db.queryOne('SELECT 1::bigint AS id, 2::int AS small');

  assert.equal(typeof row.id, 'number', 'bigint must not arrive as a string');
  assert.equal(row.id, 1);
  assert.equal(typeof row.small, 'number');
});

test('a bigint beyond the safe integer range stays a string rather than rounding', { skip }, async () => {
  // The guard on the type parser: silently rounding a value is worse than
  // returning it in a form the caller must handle deliberately.
  const row = await db.queryOne("SELECT 9223372036854775807::bigint AS huge");
  assert.equal(typeof row.huge, 'string');
});

test('numeric is deliberately NOT converted to float', { skip }, async () => {
  // parking_areas.rating_avg and the legacy bookings.amount are numeric. Float
  // conversion of money is precisely the defect this codebase removed.
  const row = await db.queryOne("SELECT 12.34::numeric AS n");
  assert.equal(typeof row.n, 'string');
});

/* ── the no-overlap exclusion constraint ───────────────────────────────────── */

async function seedLot(client) {
  const owner = await db.queryOne(
    `INSERT INTO owners (phone, name) VALUES ('9990000001','Contract Owner')
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [], client
  );
  const area = await db.queryOne(
    `INSERT INTO parking_areas (name, owner_id, base_car_price_paise, total_car_slots,
                                is_active, is_open_24_7, timezone_offset_minutes)
     VALUES ('Contract Test Lot', $1, 4000, 4, true, true, 330) RETURNING id`,
    [owner.id], client
  );
  const slots = await db.queryMany(
    `INSERT INTO parking_slots (parking_area_id, vehicle_type, code, row_label, position, slot_number)
     SELECT $1, 'car', 'C'||n, 'C', n, n FROM generate_series(1,4) n RETURNING id`,
    [area.id], client
  );
  const user = await db.queryOne(
    `INSERT INTO users (phone, name) VALUES ('9990000002','Contract User')
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [], client
  );
  return { areaId: area.id, slotIds: slots.map((s) => s.id), userId: user.id };
}

function bookingInsert(fixture, slotId, offsetHours, durationHours, status, code) {
  return db.query(
    `INSERT INTO bookings (user_id, parking_id, parking_slot_id, slot_number, vehicle_type,
                           entry_time, expected_exit_time, duration_minutes, amount_paise,
                           status, booking_code, source)
     VALUES ($1,$2,$3,1,'car',
             NOW() + ($4 || ' hours')::interval,
             NOW() + (($4::numeric + $5::numeric) || ' hours')::interval,
             $6, 4000, $7, $8, 'customer_app')`,
    [fixture.userId, fixture.areaId, slotId, offsetHours, durationHours,
     Math.round(durationHours * 60), status, code]
  );
}

test('overlapping active bookings on one slot are refused by the database', { skip }, async () => {
  const fixture = await db.withTransaction(seedLot);
  const slot = fixture.slotIds[0];

  await bookingInsert(fixture, slot, 1, 1, 'CONFIRMED', `PQX-OV${Date.now() % 10000}A`);

  await assert.rejects(
    () => bookingInsert(fixture, slot, 1.5, 1, 'CONFIRMED', `PQX-OV${Date.now() % 10000}B`),
    (err) => {
      // 23P01 — exclusion_violation. NOT an application check: the storage layer.
      assert.equal(err.code, '23P01');
      assert.match(err.constraint || '', /excl_bookings_no_overlap/);
      return true;
    },
    'the second overlapping booking must be refused by the constraint'
  );
});

test('back-to-back bookings do NOT conflict — the range is half-open', { skip }, async () => {
  const fixture = await db.withTransaction(seedLot);
  const slot = fixture.slotIds[1];

  await bookingInsert(fixture, slot, 1, 1, 'CONFIRMED', `PQX-BB${Date.now() % 10000}A`);
  // 2pm–3pm immediately after 1pm–2pm. A closed range would wrongly reject this,
  // costing the operator a booking on every clean handover.
  await assert.doesNotReject(
    () => bookingInsert(fixture, slot, 2, 1, 'CONFIRMED', `PQX-BB${Date.now() % 10000}B`)
  );
});

test('a cancelled booking does not reserve its slot', { skip }, async () => {
  const fixture = await db.withTransaction(seedLot);
  const slot = fixture.slotIds[2];

  await bookingInsert(fixture, slot, 1, 1, 'CANCELLED', `PQX-CX${Date.now() % 10000}A`);
  // The constraint is partial on active statuses, so the slot is genuinely free.
  await assert.doesNotReject(
    () => bookingInsert(fixture, slot, 1, 1, 'CONFIRMED', `PQX-CX${Date.now() % 10000}B`)
  );
});

/* ── advisory locks ────────────────────────────────────────────────────────── */

test('a transaction advisory lock actually serialises two transactions', { skip }, async () => {
  const key = `contract-test-${Date.now()}`;
  const order = [];

  const slow = db.withTransaction(async (tx) => {
    await db.advisoryXactLock(tx, 'test', key);
    order.push('A-acquired');
    await new Promise((r) => setTimeout(r, 250));
    order.push('A-released');
  });

  // Starts while A holds the lock; must not acquire until A commits.
  await new Promise((r) => setTimeout(r, 50));
  const fast = db.withTransaction(async (tx) => {
    await db.advisoryXactLock(tx, 'test', key);
    order.push('B-acquired');
  });

  await Promise.all([slow, fast]);

  assert.deepEqual(
    order,
    ['A-acquired', 'A-released', 'B-acquired'],
    'B must wait for A to finish; interleaving means the lock does nothing'
  );
});

test('tryAdvisoryXactLock reports contention instead of blocking', { skip }, async () => {
  const key = `contract-try-${Date.now()}`;
  let contended = null;

  await db.withTransaction(async (tx) => {
    await db.advisoryXactLock(tx, 'test', key);
    await db.withTransaction(async (tx2) => {
      contended = await db.tryAdvisoryXactLock(tx2, 'test', key);
    });
  });

  assert.equal(contended, false, 'a held lock must report as unavailable');
});

/* ── booking code generation ───────────────────────────────────────────────── */

test('generate_booking_code produces unambiguous, unique codes', { skip }, async () => {
  const rows = await db.queryMany(
    'SELECT generate_booking_code() AS code FROM generate_series(1, 40)'
  );
  const codes = rows.map((r) => r.code);

  assert.equal(new Set(codes).size, codes.length, 'codes must be unique');

  for (const code of codes) {
    assert.match(code, /^PQX-[2-9A-HJ-NP-Z]{6}$/, code);
    // The alphabet deliberately excludes 0/O and 1/I, because this code is read
    // aloud through a car window.
    assert.ok(!/[01OI]/.test(code.slice(4)), `${code} contains an ambiguous character`);
  }
});

/* ── the capacity impact query ─────────────────────────────────────────────── */

test('capacitySnapshot reports the bookings a reduction would strand', { skip }, async () => {
  const configRepository = require('../../src/repositories/configRepository');
  const fixture = await db.withTransaction(seedLot);

  // Book the highest-numbered slot, which a reduction to 2 would close.
  await bookingInsert(fixture, fixture.slotIds[3], 1, 1, 'CONFIRMED', `PQX-CAP${Date.now() % 1000}`);

  const snapshot = await configRepository.capacitySnapshot({
    parkingAreaId: fixture.areaId,
    vehicleType: 'car',
    fromNumber: 3, // reducing to 2 closes slots 3 and 4
  });

  assert.equal(snapshot.total_slots, 4);
  assert.equal(snapshot.closing_slot_ids.length, 2);
  assert.equal(
    snapshot.affected_booking_ids.length, 1,
    'the booking on slot 4 must be reported as affected'
  );
});

test('isOpenForWindow honours opening hours, 24/7 and the no-schedule fallback', { skip }, async () => {
  const configRepository = require('../../src/repositories/configRepository');
  const fixture = await db.withTransaction(seedLot);

  const start = new Date(Date.now() + 3600_000);
  const end = new Date(Date.now() + 7200_000);

  // The lot is seeded is_open_24_7 = true.
  const always = await configRepository.isOpenForWindow({
    parkingAreaId: fixture.areaId, startAt: start, endAt: end,
  });
  assert.equal(always.open, true, '24/7 lots are always open');

  // Turn 24/7 off with no schedule rows: the documented fallback is "always open",
  // matching OPEN_NOW_EXPR in parkingRepository.
  await db.query('UPDATE parking_areas SET is_open_24_7 = false WHERE id = $1', [fixture.areaId]);
  const noRows = await configRepository.isOpenForWindow({
    parkingAreaId: fixture.areaId, startAt: start, endAt: end,
  });
  assert.equal(noRows.open, true, 'no schedule rows means always open');

  // Add a schedule that excludes the window entirely.
  await db.query(
    `INSERT INTO parking_opening_hours (parking_area_id, day_of_week, opens_at, closes_at)
     SELECT $1, d, '03:00'::time, '03:30'::time FROM generate_series(0,6) d`,
    [fixture.areaId]
  );
  const closed = await configRepository.isOpenForWindow({
    parkingAreaId: fixture.areaId, startAt: start, endAt: end,
  });
  assert.equal(closed.open, false, 'a window outside every schedule must read as closed');
});
