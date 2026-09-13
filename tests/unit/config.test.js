'use strict';

/**
 * Safe configuration.
 *
 * The impact hash is the whole safety mechanism for capacity changes, so these
 * tests pin down exactly what invalidates it. Each corresponds to a way the world
 * can move between an operator reviewing a change and confirming it.
 *
 * Pure logic — the transactional behaviour (advisory locks, the recomputation
 * inside the transaction) needs a real Postgres and belongs in tests/integration,
 * which is not written yet.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const parkingConfigService = require('../../src/services/parkingConfigService');

const { computeImpactHash, capacityHashMaterial, validateDays, assertPrice, assertVersion } =
  parkingConfigService._internal;

/** A baseline snapshot, as `capacitySnapshot` would return it. */
function snapshot(overrides = {}) {
  return {
    total_slots: 80,
    active_slots: 80,
    max_slot_number: 80,
    closing_slot_ids: [71, 72, 73],
    closing_slot_codes: ['I7', 'I8', 'J1'],
    affected_booking_ids: [],
    affected_hold_ids: [],
    ...overrides,
  };
}

const BASE = {
  parkingAreaId: 1,
  vehicleType: 'car',
  target: 70,
  updatedAt: new Date('2026-01-01T10:00:00.000Z'),
};

function hashFor(overrides = {}, base = {}) {
  return computeImpactHash(
    capacityHashMaterial({ ...BASE, ...base, snapshot: snapshot(overrides) })
  );
}

/* ── the hash is stable for identical state ────────────────────────────────── */

test('identical state produces an identical hash', () => {
  assert.equal(hashFor(), hashFor());
});

test('row order from Postgres cannot change the hash', () => {
  // The queries do specify ORDER BY, but a hash that depended on row order would
  // produce spurious refusals the day one of them changed.
  const ascending = hashFor({ closing_slot_ids: [71, 72, 73] });
  const descending = hashFor({ closing_slot_ids: [73, 72, 71] });
  assert.equal(ascending, descending);
});

/* ── Scenario A: a customer books between preview and confirm ──────────────── */

test('SCENARIO A — a new booking on a doomed slot invalidates the preview', () => {
  const reviewed = hashFor({ affected_booking_ids: [] });
  // 10:01: a customer books slot I8.
  const afterBooking = hashFor({ affected_booking_ids: [9001] });

  assert.notEqual(
    reviewed,
    afterBooking,
    'the operator reviewed "nobody affected"; that is no longer true'
  );
});

test('SCENARIO A — a hold taken between preview and confirm also invalidates it', () => {
  const reviewed = hashFor({ affected_hold_ids: [] });
  const afterHold = hashFor({ affected_hold_ids: [4242] });
  assert.notEqual(reviewed, afterHold);
});

/* ── Scenario B: another operator changes the lot ──────────────────────────── */

test('SCENARIO B — another operator changing anything invalidates the preview', () => {
  const reviewed = hashFor();
  // A second operator edits pricing. Nothing about capacity moved, but the lot's
  // updated_at did — and the first operator reviewed a lot that no longer exists
  // in that state.
  const afterOtherEdit = hashFor({}, { updatedAt: new Date('2026-01-01T10:01:30.000Z') });

  assert.notEqual(reviewed, afterOtherEdit);
});

/* ── the request itself is part of the fingerprint ─────────────────────────── */

test('a different target produces a different hash', () => {
  assert.notEqual(hashFor(), hashFor({}, { target: 60 }));
});

test('a different vehicle type produces a different hash', () => {
  assert.notEqual(hashFor(), hashFor({}, { vehicleType: 'bike' }));
});

test('a different parking area produces a different hash', () => {
  // A hash reusable across lots would let a preview for one lot apply to another.
  assert.notEqual(hashFor(), hashFor({}, { parkingAreaId: 2 }));
});

test('a change in which slots would close invalidates the preview', () => {
  assert.notEqual(hashFor(), hashFor({ closing_slot_ids: [71, 72, 73, 74] }));
});

test('a change in current capacity invalidates the preview', () => {
  assert.notEqual(hashFor(), hashFor({ active_slots: 79 }));
});

test('the hash is short enough to travel and long enough not to collide', () => {
  const hash = hashFor();
  assert.equal(hash.length, 32);
  assert.match(hash, /^[0-9a-f]+$/);
});

/* ── opening hours validation ──────────────────────────────────────────────── */

test('a normal day is accepted', () => {
  const days = validateDays([
    { day_of_week: 1, opens_at: '08:00', closes_at: '22:00' },
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].closesNextDay, false);
});

test('a closing time at or before opening is rejected unless marked overnight', () => {
  assert.throws(
    () => validateDays([{ day_of_week: 1, opens_at: '22:00', closes_at: '06:00' }]),
    /INVALID_TIME_RANGE|Closing time must be after/
  );
  assert.throws(
    () => validateDays([{ day_of_week: 1, opens_at: '08:00', closes_at: '08:00' }]),
    /INVALID_TIME_RANGE|Closing time must be after/
  );
});

test('an overnight day is accepted when marked as such', () => {
  const days = validateDays([
    { day_of_week: 5, opens_at: '22:00', closes_at: '06:00', closes_next_day: true },
  ]);
  assert.equal(days[0].closesNextDay, true);
});

test('a day marked overnight whose closing time is later the same day is rejected', () => {
  // 08:00 → 22:00 "next day" is a 38-hour day, which is a mistake, not a schedule.
  assert.throws(
    () =>
      validateDays([
        { day_of_week: 1, opens_at: '08:00', closes_at: '22:00', closes_next_day: true },
      ]),
    /INVALID_OVERNIGHT_RANGE|not.*after midnight/
  );
});

test('a duplicated day is rejected', () => {
  assert.throws(
    () =>
      validateDays([
        { day_of_week: 1, opens_at: '08:00', closes_at: '12:00' },
        { day_of_week: 1, opens_at: '14:00', closes_at: '22:00' },
      ]),
    /DUPLICATE_DAY|only once/
  );
});

test('an out-of-range day is rejected', () => {
  assert.throws(() => validateDays([{ day_of_week: 7, opens_at: '08:00', closes_at: '22:00' }]));
  assert.throws(() => validateDays([{ day_of_week: -1, opens_at: '08:00', closes_at: '22:00' }]));
});

test('a malformed time is rejected', () => {
  assert.throws(() => validateDays([{ day_of_week: 1, opens_at: '8am', closes_at: '22:00' }]));
  assert.throws(() => validateDays([{ day_of_week: 1, opens_at: '08:00', closes_at: '' }]));
});

test('an empty week is valid and means every day is closed', () => {
  assert.deepEqual(validateDays([]), []);
  assert.deepEqual(validateDays(null), []);
});

test('days come back sorted, whatever order they arrived in', () => {
  const days = validateDays([
    { day_of_week: 5, opens_at: '08:00', closes_at: '22:00' },
    { day_of_week: 1, opens_at: '08:00', closes_at: '22:00' },
    { day_of_week: 3, opens_at: '08:00', closes_at: '22:00' },
  ]);
  assert.deepEqual(days.map((d) => d.dayOfWeek), [1, 3, 5]);
});

/* ── pricing validation ────────────────────────────────────────────────────── */

test('a whole-rupee price is accepted', () => {
  assert.doesNotThrow(() => assertPrice(4000, 'car'));
  assert.doesNotThrow(() => assertPrice(0, 'car'));
  assert.doesNotThrow(() => assertPrice(null, 'car'), 'omitted means unchanged');
});

test('a price that is not a whole number of rupees is rejected', () => {
  // The engine rounds the hourly rate to whole rupees, so accepting paise would
  // show the operator a number they never actually charge.
  assert.throws(() => assertPrice(4050, 'car'), /whole number of rupees/);
  assert.throws(() => assertPrice(1, 'car'), /whole number of rupees/);
});

test('a negative or non-integer price is rejected', () => {
  assert.throws(() => assertPrice(-100, 'car'), /negative/);
  assert.throws(() => assertPrice(40.5, 'car'), /whole number of paise/);
});

test('an implausibly high price is rejected', () => {
  // ₹10,000/hour is almost certainly rupees typed into a paise field.
  assert.throws(() => assertPrice(2000000, 'car'), /looks wrong/);
});

/* ── version token ─────────────────────────────────────────────────────────── */

test('a matching version passes', () => {
  const at = new Date('2026-01-01T10:00:00.000Z');
  assert.doesNotThrow(() => assertVersion(at, at.toISOString()));
});

test('a stale version is rejected with the current one', () => {
  const actual = new Date('2026-01-01T10:05:00.000Z');
  const stale = new Date('2026-01-01T10:00:00.000Z').toISOString();

  assert.throws(
    () => assertVersion(actual, stale),
    (err) => {
      assert.equal(err.code, 'CONFIG_VERSION_STALE');
      assert.equal(err.status, 409);
      // The client needs the current value to offer a reload.
      assert.ok(err.details.current_version);
      return true;
    }
  );
});

test('a missing version is rejected rather than defaulting to "no check"', () => {
  const at = new Date();
  assert.throws(() => assertVersion(at, null), /VERSION_REQUIRED|Reload/);
  assert.throws(() => assertVersion(at, ''), /VERSION_REQUIRED|Reload/);
  assert.throws(() => assertVersion(at, undefined), /VERSION_REQUIRED|Reload/);
});
