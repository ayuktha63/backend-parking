'use strict';

/**
 * Operator rules.
 *
 * The two that matter most are here: code normalisation (an operator types a code
 * read aloud through a car window, in whatever form they manage) and the
 * verification verdict (whether a booking admits its holder).
 *
 * Pure logic only — no database. Ownership enforcement needs real rows and belongs
 * in tests/integration, which is not written yet.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../../src/config');
const operatorService = require('../../src/services/operatorService');

const { normaliseCode, maskPhone, arrivalState, verificationFor, canOperatorCheckIn } =
  operatorService._internal;

const MINUTE = 60 * 1000;

/* ── code normalisation ────────────────────────────────────────────────────── */

test('a code is accepted in every form an operator might type it', () => {
  // All of these are the same booking. An operator reading a code off a phone
  // screen through a car window will produce any of them.
  const forms = [
    'PQX-7K9M2A',
    'pqx-7k9m2a',
    'PQX7K9M2A',
    '7K9M2A',
    '7k9m2a',
    ' PQX-7K9M2A ',
    'PQX 7K9 M2A',
  ];

  for (const form of forms) {
    assert.equal(normaliseCode(form), 'PQX-7K9M2A', `"${form}"`);
  }
});

test('junk is rejected rather than turned into a lookup', () => {
  for (const junk of ['', '   ', null, undefined, 'AB', 'PQX-', '!!!!!!', 'A'.repeat(40)]) {
    assert.equal(normaliseCode(junk), null, `${JSON.stringify(junk)} must not normalise`);
  }
});

test('normalisation never widens a code into a prefix match', () => {
  // Producing a shorter code than typed would make one booking's code match
  // another's — the one thing this function must never do.
  const out = normaliseCode('PQX-7K9M2A');
  assert.equal(out.length, 'PQX-'.length + 6);
});

/* ── phone masking ─────────────────────────────────────────────────────────── */

test('a masked phone keeps only the last four digits', () => {
  const masked = maskPhone('9876543210');
  assert.ok(masked.endsWith('3210'));
  assert.ok(!masked.includes('9876'), 'the leading digits must not survive masking');
  assert.ok(!masked.includes('54'), 'no middle digits either');
});

test('masking is defensive about junk', () => {
  for (const junk of [null, undefined, '', '12', 'abc']) {
    assert.equal(maskPhone(junk), null);
  }
});

/* ── arrival grouping ──────────────────────────────────────────────────────── */

test('arrival grouping follows the booking status first', () => {
  const now = new Date();
  const future = { expected_exit_time: new Date(now.getTime() + 60 * MINUTE) };

  assert.equal(arrivalState({ status: 'CHECKED_IN', minutesUntil: -5, row: future }), 'parked');
  assert.equal(arrivalState({ status: 'COMPLETED', minutesUntil: 0, row: {} }), 'departed');
  assert.equal(arrivalState({ status: 'CANCELLED', minutesUntil: 0, row: {} }), 'cancelled');
  assert.equal(arrivalState({ status: 'NO_SHOW', minutesUntil: 0, row: {} }), 'no_show');
  assert.equal(arrivalState({ status: 'PENDING_PAYMENT', minutesUntil: 10, row: {} }), 'unpaid');
});

test('a checked-in booking past its window is overstaying, not merely parked', () => {
  const past = { expected_exit_time: new Date(Date.now() - 30 * MINUTE) };
  assert.equal(arrivalState({ status: 'CHECKED_IN', minutesUntil: -120, row: past }), 'overstaying');
});

test('confirmed bookings group by how far away the entry time is', () => {
  const early = config.booking.checkInEarlyMinutes;
  const late = config.booking.checkInLateMinutes;

  assert.equal(
    arrivalState({ status: 'CONFIRMED', minutesUntil: early + 120, row: {} }),
    'upcoming'
  );
  assert.equal(
    arrivalState({ status: 'CONFIRMED', minutesUntil: Math.max(1, early - 5), row: {} }),
    'arriving_soon'
  );
  assert.equal(arrivalState({ status: 'CONFIRMED', minutesUntil: 0, row: {} }), 'arriving_now');
  assert.equal(arrivalState({ status: 'CONFIRMED', minutesUntil: -5, row: {} }), 'arriving_now');
  assert.equal(
    arrivalState({ status: 'CONFIRMED', minutesUntil: -(late + 30), row: {} }),
    'overdue'
  );
});

/* ── the operator's check-in window ────────────────────────────────────────── */

test("the operator's window is open at the customer's early bound", () => {
  const now = new Date();
  const early = config.booking.checkInEarlyMinutes;

  const justInside = new Date(now.getTime() + (early - 1) * MINUTE);
  assert.equal(canOperatorCheckIn({ status: 'CONFIRMED', entry: justInside, now }), true);
});

test("the operator's window does NOT close when the customer's does", () => {
  // A driver twenty minutes late is standing at the barrier with a paid booking.
  // The customer app refuses self check-in; the operator must not.
  const now = new Date();
  const veryLate = new Date(now.getTime() - (config.booking.checkInLateMinutes + 60) * MINUTE);

  assert.equal(canOperatorCheckIn({ status: 'CONFIRMED', entry: veryLate, now }), true);
});

test('the operator still cannot check in arbitrarily early', () => {
  const now = new Date();
  const tooEarly = new Date(now.getTime() + (config.booking.checkInEarlyMinutes + 60) * MINUTE);
  assert.equal(canOperatorCheckIn({ status: 'CONFIRMED', entry: tooEarly, now }), false);
});

test('only a CONFIRMED booking is checkable in by an operator', () => {
  const entry = new Date();
  for (const status of ['PENDING_PAYMENT', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW']) {
    assert.equal(canOperatorCheckIn({ status, entry, now: entry }), false, status);
  }
});

/* ── the verification verdict ──────────────────────────────────────────────── */

function bookingRow(overrides = {}) {
  return {
    status: 'CONFIRMED',
    payment_status: 'PAID',
    entry_time: new Date(),
    expected_exit_time: new Date(Date.now() + 60 * MINUTE),
    ...overrides,
  };
}

test('a paid, confirmed, on-time booking admits its holder', () => {
  const verdict = verificationFor(bookingRow());
  assert.equal(verdict.admit, true);
  assert.equal(verdict.outcome, 'admit');
});

test('a cancelled booking never admits, whatever else is true of it', () => {
  const verdict = verificationFor(bookingRow({ status: 'CANCELLED' }));
  assert.equal(verdict.admit, false);
  assert.equal(verdict.outcome, 'cancelled');
  assert.ok(verdict.headline.length > 0, 'the operator is told why, not just "no"');
});

test('an unpaid booking never admits', () => {
  // This is the case the old system got wrong in the most expensive direction: any
  // non-empty payment_id string counted as paid.
  const pending = verificationFor(bookingRow({ status: 'PENDING_PAYMENT' }));
  assert.equal(pending.admit, false);
  assert.equal(pending.outcome, 'unpaid');

  // Confirmed but with no settled payment is a genuine inconsistency, and must
  // surface rather than being waved through.
  const unconfirmed = verificationFor(bookingRow({ payment_status: 'CREATED' }));
  assert.equal(unconfirmed.admit, false);
  assert.equal(unconfirmed.outcome, 'payment_unconfirmed');
});

test('an already checked-in booking reports that state rather than admitting again', () => {
  const verdict = verificationFor(
    bookingRow({ status: 'CHECKED_IN', checked_in_at: new Date() })
  );
  assert.equal(verdict.admit, false);
  assert.equal(verdict.outcome, 'already_checked_in');
});

test('a completed or no-show booking does not admit', () => {
  assert.equal(verificationFor(bookingRow({ status: 'COMPLETED' })).outcome, 'completed');
  assert.equal(verificationFor(bookingRow({ status: 'NO_SHOW' })).outcome, 'no_show');
  assert.equal(verificationFor(bookingRow({ status: 'COMPLETED' })).admit, false);
  assert.equal(verificationFor(bookingRow({ status: 'NO_SHOW' })).admit, false);
});

test('a booking far in the future is refused as too early, with the reason', () => {
  const entry = new Date(Date.now() + (config.booking.checkInEarlyMinutes + 120) * MINUTE);
  const verdict = verificationFor(bookingRow({ entry_time: entry }));

  assert.equal(verdict.admit, false);
  assert.equal(verdict.outcome, 'too_early');
  assert.ok(/minutes/.test(verdict.detail), 'says how long, not just "too early"');
});

test('a late arrival is admitted, and flagged as an override', () => {
  const entry = new Date(Date.now() - (config.booking.checkInLateMinutes + 20) * MINUTE);
  const verdict = verificationFor(bookingRow({ entry_time: entry }));

  assert.equal(verdict.admit, true, 'a paid driver at the barrier is let in');
  assert.equal(verdict.outcome, 'admit_late');
  assert.equal(verdict.is_late, true, 'and the operator is told it counts as an override');
});

test('every non-admitting verdict explains itself', () => {
  const cases = [
    bookingRow({ status: 'CANCELLED' }),
    bookingRow({ status: 'EXPIRED' }),
    bookingRow({ status: 'NO_SHOW' }),
    bookingRow({ status: 'COMPLETED' }),
    bookingRow({ status: 'PENDING_PAYMENT' }),
    bookingRow({ payment_status: 'FAILED' }),
    bookingRow({ entry_time: new Date(Date.now() + 24 * 60 * MINUTE) }),
  ];

  for (const row of cases) {
    const verdict = verificationFor(row);
    assert.equal(verdict.admit, false);
    assert.ok(verdict.headline && verdict.headline.length > 3, 'has a headline');
    assert.ok(verdict.detail && verdict.detail.length > 10, 'has a usable explanation');
  }
});

/* ── configuration ─────────────────────────────────────────────────────────── */

test('operator check-in policy is configured coherently', () => {
  assert.ok(config.booking.checkInEarlyMinutes > 0);
  assert.ok(config.booking.checkInLateMinutes > 0);
  // The no-show sweeper must not close a booking while the operator could still
  // legitimately check it in, or a driver at the barrier would be refused by a
  // background job.
  assert.ok(
    config.booking.noShowGraceMinutes >= config.booking.checkInLateMinutes,
    'the no-show grace period must outlast the operator check-in window'
  );
});
