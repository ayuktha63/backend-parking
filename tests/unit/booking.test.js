'use strict';

/**
 * Booking rules.
 *
 * Pure logic only — everything here runs without a database, so it can run in CI
 * before anything is provisioned. The transactional behaviour (advisory locks, the
 * exclusion constraint, hold→booking conversion) needs a real Postgres and lives in
 * tests/integration, which is not written yet.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../../src/config');
const bookingService = require('../../src/services/bookingService');
const pricingService = require('../../src/services/pricingService');

const MINUTE = 60 * 1000;

/* ── check-in window ───────────────────────────────────────────────────────── */

test('check-in opens the configured number of minutes before entry', () => {
  const now = new Date();
  const early = config.booking.checkInEarlyMinutes;

  const justInside = new Date(now.getTime() + (early - 1) * MINUTE);
  const justOutside = new Date(now.getTime() + (early + 5) * MINUTE);

  assert.equal(
    bookingService.canCheckIn({ status: 'CONFIRMED', entry: justInside, now }),
    true,
    'inside the early window'
  );
  assert.equal(
    bookingService.canCheckIn({ status: 'CONFIRMED', entry: justOutside, now }),
    false,
    'too early'
  );
});

test('check-in closes after the late grace period', () => {
  const now = new Date();
  const late = config.booking.checkInLateMinutes;

  const stillOpen = new Date(now.getTime() - (late - 1) * MINUTE);
  const tooLate = new Date(now.getTime() - (late + 5) * MINUTE);

  assert.equal(bookingService.canCheckIn({ status: 'CONFIRMED', entry: stillOpen, now }), true);
  assert.equal(bookingService.canCheckIn({ status: 'CONFIRMED', entry: tooLate, now }), false);
});

test('only a CONFIRMED booking can be checked in', () => {
  const entry = new Date();
  for (const status of ['PENDING_PAYMENT', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW']) {
    assert.equal(
      bookingService.canCheckIn({ status, entry, now: entry }),
      false,
      `${status} must not be checkable-in`
    );
  }
  assert.equal(bookingService.canCheckIn({ status: 'CONFIRMED', entry, now: entry }), true);
});

test('a booking with no entry time is never checkable-in', () => {
  assert.equal(bookingService.canCheckIn({ status: 'CONFIRMED', entry: null }), false);
});

/* ── cancellability ────────────────────────────────────────────────────────── */

test('only pending and confirmed bookings are cancellable', () => {
  assert.equal(bookingService.isCancellable('PENDING_PAYMENT'), true);
  assert.equal(bookingService.isCancellable('CONFIRMED'), true);

  // A booking that has been used, or has already ended, is not cancellable — and
  // in particular CHECKED_IN is not, because the car is already in the space.
  for (const status of ['CHECKED_IN', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW']) {
    assert.equal(bookingService.isCancellable(status), false, `${status}`);
  }
});

/* ── refund slabs ──────────────────────────────────────────────────────────── */

test('refund percentage decreases as entry time approaches', () => {
  const now = new Date();
  const amountPaise = 10000; // ₹100

  const at = (minutes) =>
    pricingService.refundQuote({
      amountPaise,
      entryAt: new Date(now.getTime() + minutes * MINUTE),
      now,
    });

  const twoHours = at(120);
  const fortyFive = at(45);
  const twenty = at(20);
  const five = at(5);

  assert.ok(twoHours.refund_percent >= fortyFive.refund_percent);
  assert.ok(fortyFive.refund_percent >= twenty.refund_percent);
  assert.ok(twenty.refund_percent >= five.refund_percent);

  // The last slab is zero: cancelling minutes before arrival refunds nothing.
  assert.equal(five.refund_percent, 0);
  assert.equal(five.refund_paise, 0);
});

test('refund slabs are strictly ordered, with no two adjacent tiers equal', () => {
  // The old implementation had two adjacent tiers both set to 40%, which made the
  // boundary between them meaningless.
  const percents = config.refunds.slabs.map((s) => s.percent);
  for (let i = 1; i < percents.length; i += 1) {
    assert.ok(
      percents[i] < percents[i - 1],
      `slab ${i} (${percents[i]}%) must be strictly lower than slab ${i - 1} (${percents[i - 1]}%)`
    );
  }
});

test('refund and retained always sum to the amount paid', () => {
  const amountPaise = 12345;
  const now = new Date();

  for (const minutes of [0, 10, 20, 45, 90, 600]) {
    const quote = pricingService.refundQuote({
      amountPaise,
      entryAt: new Date(now.getTime() + minutes * MINUTE),
      now,
    });
    assert.equal(
      quote.refund_paise + quote.retained_paise,
      amountPaise,
      `at ${minutes} minutes before entry`
    );
  }
});

/* ── final amount at check-out ─────────────────────────────────────────────── */

const area = { id: 1, base_car_price_paise: 4000, base_bike_price_paise: 2000 };

function bookingFor(minutesParked, reservedMinutes, amountPaise) {
  const entry = new Date(Date.now() - minutesParked * MINUTE);
  return {
    booking: {
      vehicle_type: 'car',
      entry_time: entry,
      duration_minutes: reservedMinutes,
      amount_paise: amountPaise,
    },
    exitAt: new Date(),
  };
}

test('leaving within the reservation costs exactly what was reserved', () => {
  const { booking, exitAt } = bookingFor(45, 60, 4000);
  const settlement = pricingService.finalAmount({ booking, exitAt, parkingArea: area });

  assert.equal(settlement.total_paise, 4000);
  assert.equal(settlement.overstay_paise, 0);
  assert.equal(settlement.rule, 'within_reservation');
});

test('leaving exactly on time costs what was reserved', () => {
  const { booking, exitAt } = bookingFor(60, 60, 4000);
  const settlement = pricingService.finalAmount({ booking, exitAt, parkingArea: area });
  assert.equal(settlement.overstay_paise, 0);
  assert.equal(settlement.total_paise, 4000);
});

test('overstaying is charged per started half hour, never per second', () => {
  // The operator app computed `amount = seconds parked`, so an hour read as ₹3,600.
  const { booking, exitAt } = bookingFor(95, 60, 4000);
  const settlement = pricingService.finalAmount({ booking, exitAt, parkingArea: area });

  assert.equal(settlement.overstay_minutes, 35);
  assert.equal(settlement.overstay_half_hours, 2, '35 minutes is two started half hours');
  assert.ok(settlement.overstay_paise > 0);
  assert.equal(settlement.total_paise, 4000 + settlement.overstay_paise);

  // Sanity: nowhere near a per-second figure.
  assert.ok(settlement.total_paise < 50000, 'an extra 35 minutes must not cost hundreds of rupees');
});

test('one minute over still incurs one half-hour block', () => {
  const { booking, exitAt } = bookingFor(61, 60, 4000);
  const settlement = pricingService.finalAmount({ booking, exitAt, parkingArea: area });
  assert.equal(settlement.overstay_half_hours, 1);
});

test('a final amount is never below what was already paid', () => {
  for (const parked of [1, 30, 59, 60, 61, 200]) {
    const { booking, exitAt } = bookingFor(parked, 60, 4000);
    const settlement = pricingService.finalAmount({ booking, exitAt, parkingArea: area });
    assert.ok(
      settlement.total_paise >= 4000,
      `parked ${parked} min: total ${settlement.total_paise} must not undercut the ₹40 paid`
    );
  }
});

/* ── configuration that services depend on ─────────────────────────────────── */

test('pricing config defines every key the pricing service reads', () => {
  // Both of these were read by services and absent from config, so one bucket was
  // unreachable and one ratio silently fell back to a constant.
  assert.equal(typeof config.pricing.limitedAvailabilityRatio, 'number');
  assert.ok(config.pricing.limitedAvailabilityRatio > 0 && config.pricing.limitedAvailabilityRatio < 1);

  assert.equal(typeof config.pricing.advanceRatioByDemand, 'object');
  for (const level of ['low', 'medium', 'high', 'fallback']) {
    assert.equal(
      typeof config.pricing.advanceRatioByDemand[level],
      'number',
      `advanceRatioByDemand.${level}`
    );
  }
});

test('booking config is internally consistent', () => {
  assert.ok(config.booking.minDurationMinutes <= config.booking.maxDurationMinutes);
  assert.ok(config.booking.holdSeconds > 0);
  assert.ok(
    config.booking.pendingPaymentSeconds > config.booking.holdSeconds,
    'the payment window must outlast the hold, or a booking expires before it can be paid for'
  );
  assert.ok(config.booking.maxHoldExtensions >= 0);
});

/* ── serialisation contract ────────────────────────────────────────────────── */

test('serializeBooking returns null for a missing row rather than throwing', () => {
  assert.equal(bookingService.serializeBooking(null), null);
  assert.equal(bookingService.serializeBooking(undefined), null);
});

test('serializeBooking exposes no amount the client could have supplied', () => {
  const row = {
    id: 1,
    booking_code: 'PQX-AB23CD',
    status: 'CONFIRMED',
    parking_id: 7,
    parking_name: 'Test Lot',
    vehicle_type: 'car',
    duration_minutes: 60,
    amount_paise: 4800,
    final_amount_paise: null,
    currency: 'INR',
    entry_time: new Date(),
    expected_exit_time: new Date(Date.now() + 60 * MINUTE),
    created_at: new Date(),
    payment_status: 'PAID',
  };

  const out = bookingService.serializeBooking(row);

  assert.equal(out.code, 'PQX-AB23CD');
  assert.equal(out.amount.reserved_paise, 4800);
  // Null until check-out — the client must not render a final amount that does
  // not exist yet.
  assert.equal(out.amount.final_paise, null);
  assert.equal(out.payment.is_paid, true);
  assert.equal(out.actions.canPay, undefined, 'actions use snake_case on the wire');
  assert.equal(out.actions.can_pay, false, 'a confirmed booking is not payable again');
});

test('a pending booking is payable and cancellable, and is not checkable-in', () => {
  const row = {
    id: 2,
    booking_code: 'PQX-EF45GH',
    status: 'PENDING_PAYMENT',
    parking_id: 7,
    vehicle_type: 'car',
    duration_minutes: 60,
    amount_paise: 4800,
    entry_time: new Date(),
    expected_exit_time: new Date(Date.now() + 60 * MINUTE),
    created_at: new Date(),
    payment_status: 'CREATED',
  };

  const out = bookingService.serializeBooking(row);
  assert.equal(out.actions.can_pay, true);
  assert.equal(out.actions.is_cancellable, true);
  assert.equal(out.actions.can_check_in, false, 'unpaid bookings must not admit anyone');
  assert.equal(out.payment.is_paid, false);
});
