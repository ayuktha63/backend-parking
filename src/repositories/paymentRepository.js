'use strict';

/**
 * Payments, webhook events and refunds.
 *
 * The behaviour this replaces: the old backend stored whatever string the client
 * sent as `payment_id` and treated any non-empty value as proof of payment. There
 * was no order, no signature check, no webhook and no amount the server had decided
 * on. Typing a character into the field was a successful payment.
 *
 * Here the server creates the order (and therefore fixes the amount), and a payment
 * only becomes PAID through `markPaid`, which is conditional on the row not already
 * being settled — so a webhook and a client callback racing each other produce one
 * settlement, not two.
 */

const db = require('../db');

const PAYMENT_COLUMNS = `
  id, booking_id, user_id, provider, amount_paise, currency, status,
  provider_order_id, provider_payment_id, verified_at, failure_reason,
  amount_refunded_paise, idempotency_key, settled_at, settled_via,
  created_at, updated_at
`;

/* ── orders ────────────────────────────────────────────────────────────────── */

/**
 * Records an order the server created with the provider.
 *
 * `amountPaise` is whatever the pricing engine returned. It is never read from the
 * request body, which is the single most important line in this file.
 */
async function createOrder(
  { bookingId, userId, amountPaise, currency = 'INR', provider = 'razorpay', providerOrderId, orderPayload, idempotencyKey },
  client = null
) {
  return db.queryOne(
    `INSERT INTO payments
       (booking_id, user_id, provider, amount_paise, currency, status,
        provider_order_id, order_payload, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'CREATED', $6, $7, $8, NOW(), NOW())
     RETURNING ${PAYMENT_COLUMNS}`,
    [
      bookingId,
      userId,
      provider,
      amountPaise,
      currency,
      providerOrderId,
      JSON.stringify(orderPayload || {}),
      idempotencyKey,
    ],
    client
  );
}

/** The open order for a booking, if one exists. */
async function findOpenForBooking(bookingId, client = null) {
  return db.queryOne(
    `SELECT ${PAYMENT_COLUMNS} FROM payments
      WHERE booking_id = $1 AND status IN ('CREATED', 'AUTHORIZED')
      ORDER BY created_at DESC LIMIT 1`,
    [bookingId],
    client
  );
}

async function findById(paymentId, client = null) {
  return db.queryOne(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`, [paymentId], client);
}

async function findByProviderOrderId(providerOrderId, client = null) {
  return db.queryOne(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE provider_order_id = $1`,
    [providerOrderId],
    client
  );
}

async function findByProviderPaymentId(providerPaymentId, client = null) {
  return db.queryOne(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE provider_payment_id = $1`,
    [providerPaymentId],
    client
  );
}

async function findPaidForBooking(bookingId, client = null) {
  return db.queryOne(
    `SELECT ${PAYMENT_COLUMNS} FROM payments
      WHERE booking_id = $1 AND status = 'PAID'
      ORDER BY settled_at DESC NULLS LAST LIMIT 1`,
    [bookingId],
    client
  );
}

/** Locks a payment row for a settlement decision. Must be inside a transaction. */
async function lockById(paymentId, client) {
  return db.queryOne(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 FOR UPDATE`,
    [paymentId],
    client
  );
}

/* ── settlement ────────────────────────────────────────────────────────────── */

/**
 * Every order for a booking that has not been paid, newest first — including ones
 * recorded as FAILED or abandoned.
 *
 * Our FAILED says an attempt did not complete from where we stood; it does not
 * close the order at the gateway. A declined card retried on the same order, or a
 * UPI collect approved after the sheet was closed, still captures money against it.
 */
async function listUnpaidOrdersForBooking(bookingId, client = null) {
  return db.queryMany(
    `SELECT ${PAYMENT_COLUMNS} FROM payments
      WHERE booking_id = $1
        AND provider_order_id IS NOT NULL
        AND status IN ('CREATED', 'AUTHORIZED', 'FAILED')
      ORDER BY created_at DESC`,
    [bookingId],
    client
  );
}

/**
 * Marks a payment PAID — the only place that does.
 *
 * Conditional on the payment not already being PAID (or refunded), so it is
 * idempotent by construction: the second caller (webhook or client callback,
 * whichever loses the race) gets null back and knows to treat the payment as
 * already settled rather than settling it again. That is the difference between
 * "duplicate callback handled" and "customer's booking confirmed twice".
 *
 * A FAILED payment can still become PAID. Only verified captures reach this —
 * a checkout signature, a signed webhook, or the gateway's own answer — and money
 * the gateway captured is money received, whatever an earlier attempt reported.
 * Conditioning on `settled_at IS NULL` instead stranded exactly those payments:
 * charged, and the booking never confirmed.
 */
async function markPaid(
  { paymentId, providerPaymentId, signature, verifyPayload, settledVia },
  client
) {
  return db.queryOne(
    `UPDATE payments
        SET status = 'PAID',
            provider_payment_id = COALESCE($2, provider_payment_id),
            provider_signature  = COALESCE($3, provider_signature),
            verify_payload      = $4,
            verified_at         = NOW(),
            settled_at          = NOW(),
            settled_via         = $5,
            failure_reason      = NULL,
            updated_at          = NOW()
      WHERE id = $1
        AND status IN ('CREATED', 'AUTHORIZED', 'FAILED')
      RETURNING ${PAYMENT_COLUMNS}`,
    [paymentId, providerPaymentId, signature, JSON.stringify(verifyPayload || {}), settledVia],
    client
  );
}

async function markFailed({ paymentId, reason, payload = {}, settledVia = 'client_callback' }, client = null) {
  return db.queryOne(
    `UPDATE payments
        SET status = 'FAILED',
            failure_reason = $2,
            verify_payload = $3,
            settled_at = COALESCE(settled_at, NOW()),
            settled_via = COALESCE(settled_via, $4),
            updated_at = NOW()
      WHERE id = $1 AND settled_at IS NULL
      RETURNING ${PAYMENT_COLUMNS}`,
    [paymentId, String(reason || 'unknown').slice(0, 300), JSON.stringify(payload || {}), settledVia],
    client
  );
}

/**
 * Abandons an unpaid order so a fresh one can be created.
 *
 * Needed because 0009 allows only one open payment per booking: without this, a
 * customer who backs out of checkout and returns could never start a second attempt.
 */
async function abandonOpenOrders({ bookingId, reason = 'superseded' }, client = null) {
  return db.queryMany(
    `UPDATE payments
        SET status = 'FAILED',
            failure_reason = $2,
            settled_at = NOW(),
            settled_via = 'reconciliation',
            updated_at = NOW()
      WHERE booking_id = $1 AND status IN ('CREATED', 'AUTHORIZED') AND settled_at IS NULL
      RETURNING id`,
    [bookingId, reason],
    client
  );
}

/* ── webhooks ──────────────────────────────────────────────────────────────── */

/**
 * Claims a webhook event for processing.
 *
 * Returns null when this event id has been seen before, which is how a provider
 * that retries delivery (all of them do) cannot cause the same payment to be
 * processed twice. The unique index from 0002 does the actual work.
 */
async function claimWebhookEvent({ provider = 'razorpay', eventId, eventType, payload }, client = null) {
  return db.queryOne(
    `INSERT INTO provider_webhook_events (provider, event_id, event_type, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id, event_id, event_type, created_at`,
    [provider, eventId, eventType, JSON.stringify(payload || {})],
    client
  );
}

async function markWebhookProcessed({ id, error = null }, client = null) {
  return db.queryOne(
    `UPDATE provider_webhook_events
        SET processed_at = NOW(), error = $2
      WHERE id = $1
      RETURNING id`,
    [id, error ? String(error).slice(0, 500) : null],
    client
  );
}

/* ── refunds ───────────────────────────────────────────────────────────────── */

/**
 * Records a refund obligation.
 *
 * Written even when FEATURE_REFUNDS_ENABLED is off — the row stays PENDING and the
 * money owed is visible in the database rather than existing only in the mind of
 * whoever cancelled. The old flow told the user "Booking Cancelled" and never
 * mentioned money at all.
 */
async function createRefund(
  { paymentId, bookingId, amountPaise, reason, status = 'PENDING' },
  client = null
) {
  return db.queryOne(
    `INSERT INTO refunds (payment_id, booking_id, amount_paise, reason, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, payment_id, booking_id, amount_paise, reason, status, created_at`,
    [paymentId, bookingId, amountPaise, reason, status],
    client
  );
}

async function markRefundProcessed(
  { refundId, providerRefundId, status = 'COMPLETED', payload = {}, failureReason = null },
  client = null
) {
  return db.queryOne(
    `UPDATE refunds
        SET status = $3,
            provider_refund_id = COALESCE($2, provider_refund_id),
            provider_payload = $4,
            failure_reason = $5,
            processed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, status, amount_paise`,
    [refundId, providerRefundId, status, JSON.stringify(payload || {}), failureReason],
    client
  );
}

/** Keeps the denormalised refunded total on the payment in step. */
async function addRefundedAmount({ paymentId, amountPaise }, client = null) {
  return db.queryOne(
    `UPDATE payments
        SET amount_refunded_paise = LEAST(amount_paise, amount_refunded_paise + $2),
            status = CASE
              WHEN amount_refunded_paise + $2 >= amount_paise THEN 'REFUNDED'
              ELSE 'PARTIALLY_REFUNDED'
            END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${PAYMENT_COLUMNS}`,
    [paymentId, amountPaise],
    client
  );
}

/** The refund already owed on one payment, if any. */
async function findRefundForPayment(paymentId, client = null) {
  return db.queryOne(
    `SELECT id, payment_id, booking_id, amount_paise, reason, status, created_at
       FROM refunds WHERE payment_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [paymentId],
    client
  );
}

async function listRefundsForBooking(bookingId, client = null) {
  return db.queryMany(
    `SELECT id, amount_paise, reason, status, provider_refund_id, processed_at, created_at
       FROM refunds WHERE booking_id = $1 ORDER BY created_at DESC`,
    [bookingId],
    client
  );
}

module.exports = {
  createOrder,
  findOpenForBooking,
  findById,
  findByProviderOrderId,
  findByProviderPaymentId,
  findPaidForBooking,
  listUnpaidOrdersForBooking,
  lockById,
  markPaid,
  markFailed,
  abandonOpenOrders,
  claimWebhookEvent,
  markWebhookProcessed,
  createRefund,
  markRefundProcessed,
  addRefundedAmount,
  findRefundForPayment,
  listRefundsForBooking,
};
