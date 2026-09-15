'use strict';

/**
 * Payment settlement, against a real database.
 *
 * What is real: every service, repository and SQL statement, the Postgres schema
 * with all migrations, and the HMAC signatures — computed exactly as Razorpay
 * computes them, and checked by the production verification code.
 *
 * What is not: Razorpay's HTTP API. A development environment has no gateway
 * credentials, so the SDK is replaced by a small in-memory stand-in that behaves
 * like the gateway (orders, payments on an order, fetch). It exists only inside
 * this test process; nothing in src/ can reach it.
 *
 * Each test is a way real money moved while the booking did not follow — found by
 * reading the settlement code, reproduced here first, then fixed.
 *
 * Requires DATABASE_URL with migrations applied.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skip = HAS_DB ? false : 'DATABASE_URL is not set — no database to test against';

// Test-only values, set before config is first read. Not credentials.
const KEY_SECRET = 'contract-test-key-secret';
const WEBHOOK_SECRET = 'contract-test-webhook-secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_contract';
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.FEATURE_SERVER_PAYMENT_VERIFICATION = 'true';

/* ── the gateway stand-in ──────────────────────────────────────────────────── */

const gateway = { orders: new Map(), payments: new Map(), orderCreates: 0, seq: 0 };

class GatewayStandIn {
  constructor() {
    this.orders = {
      create: async ({ amount, currency, receipt, notes }) => {
        gateway.orderCreates += 1;
        const order = {
          id: `order_ct${Date.now()}${++gateway.seq}`,
          entity: 'order',
          amount,
          currency,
          receipt,
          notes,
          status: 'created',
          created_at: Math.floor(Date.now() / 1000),
        };
        gateway.orders.set(order.id, order);
        return order;
      },
      fetchPayments: async (orderId) => {
        const items = [...gateway.payments.values()].filter((p) => p.order_id === orderId);
        return { entity: 'collection', count: items.length, items };
      },
    };
    this.payments = {
      fetch: async (paymentId) => {
        const payment = gateway.payments.get(paymentId);
        if (!payment) throw Object.assign(new Error('not found'), { statusCode: 400 });
        return payment;
      },
      refund: async (paymentId, { amount }) => ({ id: `rfnd_${paymentId}`, status: 'processed', amount }),
    };
  }
}

if (HAS_DB) {
  const resolved = require.resolve('razorpay');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: GatewayStandIn };
}

/** The customer pays at the gateway: a payment attempt on an order. */
function gatewayPayment(orderId, { status = 'captured', amount } = {}) {
  const order = gateway.orders.get(orderId);
  const payment = {
    id: `pay_ct${Date.now()}${++gateway.seq}`,
    entity: 'payment',
    order_id: orderId,
    status,
    amount: amount ?? order.amount,
    currency: 'INR',
    method: 'upi',
    captured: status === 'captured',
    error_description: status === 'failed' ? 'Payment declined by the bank' : null,
  };
  gateway.payments.set(payment.id, payment);
  return payment;
}

/** What Checkout hands the device: HMAC-SHA256(order_id|payment_id). */
function checkoutSignature(orderId, paymentId) {
  return crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

/** A webhook delivery, signed over its exact bytes. */
function webhookDelivery(event, payment) {
  const body = JSON.stringify({
    entity: 'event',
    event,
    payload: { payment: { entity: payment } },
    created_at: Math.floor(Date.now() / 1000),
  });
  return {
    rawBody: Buffer.from(body),
    signature: crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'),
    parsedBody: JSON.parse(body),
  };
}

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const db = HAS_DB ? require('../../src/db') : null;
const bookingService = HAS_DB ? require('../../src/services/bookingService') : null;
const paymentService = HAS_DB ? require('../../src/services/paymentService') : null;

test.after(async () => {
  if (HAS_DB) await db.close();
});

let fixtureSeq = 0;
async function fixture() {
  const stamp = `${Date.now() % 1000000}`.padStart(6, '0') + String(++fixtureSeq % 100).padStart(2, '0');
  const owner = await db.queryOne(
    `INSERT INTO owners (phone, name) VALUES ($1, 'Settlement Owner') RETURNING id`,
    [`96${stamp}`]
  );
  const user = await db.queryOne(
    `INSERT INTO users (phone, name) VALUES ($1, 'Settlement Customer') RETURNING id`,
    [`95${stamp}`]
  );
  const area = await db.queryOne(
    `INSERT INTO parking_areas (name, owner_id, base_car_price_paise, total_car_slots,
                                is_active, is_open_24_7, timezone_offset_minutes)
     VALUES ($1, $2, 4000, 3, true, true, 330) RETURNING *`,
    [`Settlement Lot ${stamp}`, owner.id]
  );
  const slots = await db.queryMany(
    `INSERT INTO parking_slots (parking_area_id, vehicle_type, code, row_label, position, slot_number)
     SELECT $1, 'car', 'S'||n, 'S', n, n FROM generate_series(1,3) n RETURNING id`,
    [area.id]
  );
  return { userId: user.id, area, slots };
}

/** A booking awaiting payment, made the way the app makes it. */
async function pendingBooking() {
  const f = await fixture();
  const hold = await bookingService.createHold({
    userId: f.userId,
    parkingAreaId: f.area.id,
    slotId: f.slots[0].id,
    startAt: new Date(Date.now() + 3600_000),
    durationMinutes: 60,
  });
  const { booking } = await bookingService.createFromHold({
    userId: f.userId,
    holdId: hold.id,
    numberPlate: 'KA01PAY001',
    idempotencyKey: `settle-${Date.now()}-${fixtureSeq}`,
  });
  return { ...f, holdId: hold.id, booking };
}

const bookingStatus = async (bookingId) =>
  (await db.queryOne('SELECT status FROM bookings WHERE id = $1', [bookingId])).status;

const confirmations = async (bookingId) =>
  (
    await db.queryOne(
      `SELECT COUNT(*)::int AS n FROM booking_events WHERE booking_id = $1 AND event_type = 'payment_confirmed'`,
      [bookingId]
    )
  ).n;

const paymentRows = (bookingId) =>
  db.queryMany('SELECT * FROM payments WHERE booking_id = $1 ORDER BY id', [bookingId]);

const refundRows = (bookingId) =>
  db.queryMany('SELECT * FROM refunds WHERE booking_id = $1 ORDER BY id', [bookingId]);

/* ── order creation ────────────────────────────────────────────────────────── */

test('the order is created server-side for the booking amount, once', { skip }, async () => {
  const { userId, booking } = await pendingBooking();
  const before = gateway.orderCreates;

  const first = await paymentService.createOrderForBooking({ userId, bookingId: booking.id, idempotencyKey: 'k1' });
  const second = await paymentService.createOrderForBooking({ userId, bookingId: booking.id, idempotencyKey: 'k1' });

  assert.equal(gateway.orderCreates - before, 1, 'a repeated request must not open a second order');
  assert.equal(second.provider_order_id, first.provider_order_id);
  const stored = await db.queryOne('SELECT amount_paise FROM bookings WHERE id = $1', [booking.id]);
  assert.equal(first.amount_paise, stored.amount_paise, 'the charge is the booking amount');
  assert.equal(gateway.orders.get(first.provider_order_id).amount, stored.amount_paise);

  // The fields the app reads to open Checkout. Renaming any of them breaks real
  // payments in a way no development environment without credentials would show.
  for (const key of ['payment_id', 'booking_id', 'provider_order_id', 'key_id', 'amount_paise', 'currency', 'description']) {
    assert.ok(key in first, `order response carries ${key}`);
  }
  assert.equal(typeof first.booking_id, 'number');
  assert.equal(typeof first.payment_id, 'number');
  assert.equal(first.key_id, 'rzp_test_contract');
  assert.ok(!JSON.stringify(first).includes(KEY_SECRET), 'the secret never leaves the server');
});

/* ── the two settlement paths and their races ──────────────────────────────── */

test('a genuine checkout result confirms the booking', { skip }, async () => {
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  const paid = gatewayPayment(order.provider_order_id);

  const result = await paymentService.verifyClientCallback({
    userId,
    bookingId: booking.id,
    providerOrderId: order.provider_order_id,
    providerPaymentId: paid.id,
    signature: checkoutSignature(order.provider_order_id, paid.id),
  });

  assert.equal(result.booking.status, 'CONFIRMED');
  assert.equal(result.confirmed, true);
  assert.equal(await bookingStatus(booking.id), 'CONFIRMED');
  const [payment] = await paymentRows(booking.id);
  assert.equal(payment.status, 'PAID');
  assert.equal(payment.settled_via, 'client_callback');
});

test('webhook first, then the callback: settled once', { skip }, async () => {
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  const paid = gatewayPayment(order.provider_order_id);

  await paymentService.handleWebhook(webhookDelivery('payment.captured', paid));
  const late = await paymentService.verifyClientCallback({
    userId,
    bookingId: booking.id,
    providerOrderId: order.provider_order_id,
    providerPaymentId: paid.id,
    signature: checkoutSignature(order.provider_order_id, paid.id),
  });

  assert.equal(late.already_settled, true);
  assert.equal(late.booking.status, 'CONFIRMED');
  assert.equal(await confirmations(booking.id), 1);
  assert.equal((await paymentRows(booking.id)).filter((p) => p.status === 'PAID').length, 1);
});

test('callback first, then the webhook: settled once', { skip }, async () => {
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  const paid = gatewayPayment(order.provider_order_id);

  await paymentService.verifyClientCallback({
    userId,
    bookingId: booking.id,
    providerOrderId: order.provider_order_id,
    providerPaymentId: paid.id,
    signature: checkoutSignature(order.provider_order_id, paid.id),
  });
  const webhook = await paymentService.handleWebhook(webhookDelivery('payment.captured', paid));

  assert.equal(webhook.action, 'already_settled');
  assert.equal(await confirmations(booking.id), 1);
});

test('callback and webhook at the same instant: one settlement', { skip }, async () => {
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  const paid = gatewayPayment(order.provider_order_id);

  const outcomes = await Promise.all([
    paymentService.verifyClientCallback({
      userId,
      bookingId: booking.id,
      providerOrderId: order.provider_order_id,
      providerPaymentId: paid.id,
      signature: checkoutSignature(order.provider_order_id, paid.id),
    }),
    paymentService.handleWebhook(webhookDelivery('payment.captured', paid)),
    paymentService.verifyClientCallback({
      userId,
      bookingId: booking.id,
      providerOrderId: order.provider_order_id,
      providerPaymentId: paid.id,
      signature: checkoutSignature(order.provider_order_id, paid.id),
    }),
  ]);

  assert.equal(outcomes.length, 3);
  assert.equal(await bookingStatus(booking.id), 'CONFIRMED');
  assert.equal(await confirmations(booking.id), 1, 'exactly one confirmation event');
  assert.equal((await paymentRows(booking.id)).filter((p) => p.status === 'PAID').length, 1);
  assert.equal((await refundRows(booking.id)).length, 0, 'no refund for a single payment');
});

test('a replayed webhook is dropped', { skip }, async () => {
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  const paid = gatewayPayment(order.provider_order_id);
  const delivery = webhookDelivery('payment.captured', paid);

  const first = await paymentService.handleWebhook(delivery);
  const replay = await paymentService.handleWebhook(delivery);

  assert.equal(first.handled, true);
  assert.equal(replay.handled, false);
  assert.equal(replay.reason, 'duplicate');
  assert.equal(await confirmations(booking.id), 1);
});

test('an unsigned or wrongly signed webhook changes nothing', { skip }, async () => {
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  const paid = gatewayPayment(order.provider_order_id);
  const delivery = webhookDelivery('payment.captured', paid);

  await assert.rejects(paymentService.handleWebhook({ ...delivery, signature: 'f'.repeat(64) }), {
    code: 'WEBHOOK_SIGNATURE_INVALID',
  });
  assert.equal(await bookingStatus(booking.id), 'PENDING_PAYMENT');
});

/* ── money moved, booking did not follow ───────────────────────────────────── */

test('a forged signature is refused and does not block the genuine payment', { skip }, async () => {
  // REGRESSION: a failed verification marked the payment FAILED *and settled*.
  // The real capture then arrived by webhook, found it "already settled", and
  // the customer's paid booking stayed unconfirmed until it expired.
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  const paid = gatewayPayment(order.provider_order_id);

  await assert.rejects(
    paymentService.verifyClientCallback({
      userId,
      bookingId: booking.id,
      providerOrderId: order.provider_order_id,
      providerPaymentId: paid.id,
      signature: 'a'.repeat(64),
    }),
    { code: 'PAYMENT_VERIFICATION_FAILED' }
  );
  assert.equal(await bookingStatus(booking.id), 'PENDING_PAYMENT', 'a forged result confirms nothing');

  await paymentService.handleWebhook(webhookDelivery('payment.captured', paid));
  assert.equal(await bookingStatus(booking.id), 'CONFIRMED');
});

test('a declined attempt followed by a successful retry on the same order confirms', { skip }, async () => {
  // REGRESSION: Checkout retries on the same order. The declined attempt's
  // payment.failed webhook settled the order as FAILED, so the successful retry
  // could not confirm the booking.
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });

  const declined = gatewayPayment(order.provider_order_id, { status: 'failed' });
  await paymentService.handleWebhook(webhookDelivery('payment.failed', declined));

  const retried = gatewayPayment(order.provider_order_id);
  const result = await paymentService.verifyClientCallback({
    userId,
    bookingId: booking.id,
    providerOrderId: order.provider_order_id,
    providerPaymentId: retried.id,
    signature: checkoutSignature(order.provider_order_id, retried.id),
  });

  assert.equal(result.booking.status, 'CONFIRMED');
  assert.equal(await bookingStatus(booking.id), 'CONFIRMED');
});

test('a payment approved after the customer closed checkout still confirms, and the newer order is closed', { skip }, async () => {
  // REGRESSION: closing the sheet reported a failure that settled the order. A UPI
  // collect approved a minute later captured money against a "settled" order.
  const { userId, booking } = await pendingBooking();
  const orderA = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  await paymentService.recordClientFailure({
    userId,
    bookingId: booking.id,
    providerOrderId: orderA.provider_order_id,
    reason: 'cancelled_by_user',
  });

  const orderB = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  assert.notEqual(orderB.provider_order_id, orderA.provider_order_id, 'retry opens a fresh order');

  const lateApproval = gatewayPayment(orderA.provider_order_id);
  await paymentService.handleWebhook(webhookDelivery('payment.captured', lateApproval));

  assert.equal(await bookingStatus(booking.id), 'CONFIRMED');
  const rows = await paymentRows(booking.id);
  const b = rows.find((p) => p.provider_order_id === orderB.provider_order_id);
  assert.notEqual(b.status, 'CREATED', 'the unused order can no longer be treated as open');
  await assert.rejects(
    paymentService.createOrderForBooking({ userId, bookingId: booking.id }),
    { code: 'PAYMENT_ALREADY_SETTLED' }
  );
});

test('paying twice confirms once and records a refund for the second payment', { skip }, async () => {
  const { userId, booking } = await pendingBooking();
  const orderA = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  await paymentService.recordClientFailure({ userId, bookingId: booking.id, providerOrderId: orderA.provider_order_id });
  const orderB = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });

  const payA = gatewayPayment(orderA.provider_order_id);
  const payB = gatewayPayment(orderB.provider_order_id);
  await paymentService.handleWebhook(webhookDelivery('payment.captured', payA));
  const second = await paymentService.handleWebhook(webhookDelivery('payment.captured', payB));

  assert.equal(second.action, 'refund_due');
  assert.equal(await bookingStatus(booking.id), 'CONFIRMED');
  assert.equal(await confirmations(booking.id), 1);
  const refunds = await refundRows(booking.id);
  assert.equal(refunds.length, 1, 'the second payment is owed back');
  const paidB = (await paymentRows(booking.id)).find((p) => p.provider_order_id === orderB.provider_order_id);
  assert.equal(Number(refunds[0].payment_id), Number(paidB.id));
  assert.equal(refunds[0].amount_paise, paidB.amount_paise, 'refunded in full');
  assert.equal(refunds[0].reason, 'duplicate_payment');
});

test('two orders captured at the same instant: one confirmation, one refund, no deadlock', { skip }, async () => {
  // Settlement locked the payment row, then the booking row; closing the other
  // orders then waited on a payment row the second settlement held, while that
  // settlement waited on the booking row. Locking the booking first serialises them.
  const { userId, booking } = await pendingBooking();
  const orderA = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  await paymentService.recordClientFailure({ userId, bookingId: booking.id, providerOrderId: orderA.provider_order_id });
  const orderB = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  const payA = gatewayPayment(orderA.provider_order_id);
  const payB = gatewayPayment(orderB.provider_order_id);

  const results = await Promise.all([
    paymentService.handleWebhook(webhookDelivery('payment.captured', payA)),
    paymentService.handleWebhook(webhookDelivery('payment.captured', payB)),
  ]);

  assert.deepEqual(results.map((r) => r.action).sort(), ['confirmed', 'refund_due']);
  assert.equal(await bookingStatus(booking.id), 'CONFIRMED');
  assert.equal(await confirmations(booking.id), 1);
  assert.equal((await refundRows(booking.id)).length, 1);
});

test('a capture after the booking expired is refunded, never reported as booked', { skip }, async () => {
  // REGRESSION: settlement marked the payment PAID and answered "verified" with an
  // EXPIRED booking; nothing recorded that the money had to go back.
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  await db.query(`UPDATE bookings SET status = 'EXPIRED' WHERE id = $1`, [booking.id]);

  const paid = gatewayPayment(order.provider_order_id);
  const result = await paymentService.verifyClientCallback({
    userId,
    bookingId: booking.id,
    providerOrderId: order.provider_order_id,
    providerPaymentId: paid.id,
    signature: checkoutSignature(order.provider_order_id, paid.id),
  });

  assert.equal(result.confirmed, false);
  assert.equal(result.refund_due, true);
  assert.equal(result.booking.status, 'EXPIRED', 'an expired booking is not revived');
  const refunds = await refundRows(booking.id);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].reason, 'captured_after_booking_closed');
});

/* ── reconciliation: neither callback nor webhook arrived ───────────────────── */

test('reconcile finds a payment the server was never told about', { skip }, async () => {
  // REGRESSION: reconcile could only ask about a payment id the server already
  // had — which only the callback or webhook supply. With the app killed during
  // checkout it always answered "no payment attempt".
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  gatewayPayment(order.provider_order_id, { status: 'failed' });
  gatewayPayment(order.provider_order_id);

  const result = await paymentService.reconcile({ userId, bookingId: booking.id });

  assert.equal(result.reconciled, true);
  assert.equal(result.booking.status, 'CONFIRMED');
});

test('reconcile with nothing captured leaves the booking payable', { skip }, async () => {
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  gatewayPayment(order.provider_order_id, { status: 'failed' });

  const result = await paymentService.reconcile({ userId, bookingId: booking.id });

  assert.equal(result.reconciled, false);
  assert.equal(await bookingStatus(booking.id), 'PENDING_PAYMENT');
});

test('the unpaid-booking sweeper confirms a paid booking instead of expiring it', { skip }, async () => {
  const jobs = require('../../src/jobs');
  const { userId, booking } = await pendingBooking();
  const order = await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  gatewayPayment(order.provider_order_id);
  await db.query(`UPDATE bookings SET created_at = NOW() - interval '2 hours' WHERE id = $1`, [booking.id]);

  await jobs.sweepUnpaidBookings();

  assert.equal(await bookingStatus(booking.id), 'CONFIRMED', 'money was taken, so the booking stands');
});

test('the sweeper still expires a booking nobody paid for, and closes its order', { skip }, async () => {
  const jobs = require('../../src/jobs');
  const { userId, booking } = await pendingBooking();
  await paymentService.createOrderForBooking({ userId, bookingId: booking.id });
  await db.query(`UPDATE bookings SET created_at = NOW() - interval '2 hours' WHERE id = $1`, [booking.id]);

  await jobs.sweepUnpaidBookings();

  assert.equal(await bookingStatus(booking.id), 'EXPIRED');
  const open = (await paymentRows(booking.id)).filter((p) => ['CREATED', 'AUTHORIZED'].includes(p.status));
  assert.equal(open.length, 0, 'an expired booking keeps no open order');
});

/* ── holds ─────────────────────────────────────────────────────────────────── */

test('an expired hold cannot become a booking, and the hold is kept', { skip }, async () => {
  const f = await fixture();
  const hold = await bookingService.createHold({
    userId: f.userId,
    parkingAreaId: f.area.id,
    slotId: f.slots[1].id,
    startAt: new Date(Date.now() + 3600_000),
    durationMinutes: 60,
  });
  await db.query(`UPDATE slot_holds SET hold_expires_at = NOW() - interval '1 minute' WHERE id = $1`, [hold.id]);

  await assert.rejects(
    bookingService.createFromHold({ userId: f.userId, holdId: hold.id, numberPlate: 'KA01HOLD01' }),
    (err) => err.status >= 400 && err.status < 500
  );
  const kept = await db.queryOne('SELECT id FROM slot_holds WHERE id = $1', [hold.id]);
  assert.ok(kept, 'the hold row is kept for the audit trail');
});

/* ── the old surface ───────────────────────────────────────────────────────── */

test('the legacy booking endpoint neither books nor trusts a payment id', { skip }, async () => {
  // REGRESSION: POST /api/bookings marks a booking paid for any non-empty
  // payment_id, unauthenticated. Before migration 0008 that was a free booking;
  // after it, a 500 that echoes the SQL error. Either way it was a second, unsafe
  // booking system.
  const request = require('supertest');
  const { createApp } = require('../../src/app');
  const f = await fixture();
  const plate = `KA01LG${String(fixtureSeq).padStart(4, '0')}`;

  const res = await request(createApp())
    .post('/api/bookings')
    .send({
      parking_id: f.area.id,
      slot_number: 1,
      vehicle_type: 'car',
      number_plate: plate,
      entry_time: new Date(Date.now() + 3600_000).toISOString(),
      phone: '9000000077',
      payment_id: 'pay_not_real',
      amount: 1,
    });

  assert.equal(res.status, 410);
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('column'), 'no internals in the response');
  const rows = await db.queryOne('SELECT COUNT(*)::int AS n FROM bookings WHERE number_plate = $1', [plate]);
  assert.equal(rows.n, 0);
});

test('the legacy cancel endpoint cannot delete a booking', { skip }, async () => {
  // REGRESSION: POST /api/bookings/cancel — unauthenticated — archives the row to
  // booking_history and then runs DELETE FROM bookings. Before migration 0008 that
  // deleted any booking without a payment row, audit events and all; after it, the
  // read-only booking_history trigger turns it into a 500. Neither is a way to
  // cancel a booking; the one way is /api/v1.
  const request = require('supertest');
  const { createApp } = require('../../src/app');
  const { booking, area } = await pendingBooking();

  const res = await request(createApp())
    .post('/api/bookings/cancel')
    .send({ booking_id: booking.id, parking_id: area.id, vehicle_type: 'car' });

  assert.equal(res.status, 410);
  assert.equal(await bookingStatus(booking.id), 'PENDING_PAYMENT', 'the booking is still there, unchanged');
});
