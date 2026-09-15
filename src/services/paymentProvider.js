'use strict';

/**
 * Payment provider adapter (Razorpay).
 *
 * Isolated behind this interface for two reasons: the rest of the system should not
 * import a vendor SDK, and signature verification should be readable rather than
 * hidden inside a library call that nobody on the team has checked.
 *
 * Deliberately absent: a mock provider that returns success when no keys are
 * configured. A payment system that can be made to succeed without a gateway is not
 * a payment system. With no credentials, order creation fails loudly and the
 * booking stays PENDING_PAYMENT — which is the truth.
 */

const crypto = require('crypto');
const { config } = require('../config');
const { logger } = require('../utils/logger');
const { serviceUnavailable, internal } = require('../utils/errors');

const rp = config.payments.razorpay;

let client = null;

function isConfigured() {
  return Boolean(rp.keyId && rp.keySecret);
}

/** Lazily constructed so a missing SDK cannot stop the process booting. */
function getClient() {
  if (client) return client;
  if (!isConfigured()) {
    throw serviceUnavailable(
      'Payments are not available right now. Please try again shortly.'
    );
  }

  try {
    // eslint-disable-next-line global-require
    const Razorpay = require('razorpay');
    client = new Razorpay({ key_id: rp.keyId, key_secret: rp.keySecret });
    return client;
  } catch (err) {
    logger.error({ err }, 'Razorpay SDK could not be loaded');
    throw serviceUnavailable('Payments are not available right now.', err);
  }
}

/**
 * Creates an order with the provider.
 *
 * `amountPaise` is whatever the server computed. `receipt` carries our booking code
 * so a payment can be traced back from the provider's dashboard without a database
 * lookup — which is the first thing anyone needs during a dispute.
 */
async function createOrder({ amountPaise, currency = 'INR', receipt, notes = {} }) {
  const api = getClient();

  try {
    const order = await api.orders.create({
      amount: amountPaise,
      currency,
      receipt: String(receipt).slice(0, 40),
      // Captured automatically: a two-step authorise/capture flow adds a failure
      // mode (authorised-but-never-captured) with no benefit for parking.
      payment_capture: 1,
      notes,
    });

    return {
      id: order.id,
      amount: Number(order.amount),
      currency: order.currency,
      status: order.status,
      receipt: order.receipt,
      created_at: order.created_at,
    };
  } catch (err) {
    logger.error(
      { err: { message: err?.message, statusCode: err?.statusCode } },
      'Provider order creation failed'
    );
    throw serviceUnavailable('We could not start the payment. Please try again.');
  }
}

/**
 * Verifies the signature returned to the client by Razorpay Checkout.
 *
 * HMAC-SHA256 over `order_id|payment_id`, keyed with the secret. This is the entire
 * basis on which a payment is believed. The old system believed a non-empty string.
 *
 * Compared with `timingSafeEqual` — a plain `===` on an HMAC leaks its contents one
 * byte at a time to anyone willing to measure.
 */
function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  if (!rp.keySecret || !orderId || !paymentId || !signature) return false;

  const expected = crypto
    .createHmac('sha256', rp.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  return safeEqual(expected, signature);
}

/**
 * Verifies a webhook body signature.
 *
 * Computed over the exact bytes received — which is why app.js retains `rawBody`
 * for this path. Re-serialising the parsed JSON would change key order and
 * whitespace, and the signature would never match.
 */
function verifyWebhookSignature({ rawBody, signature }) {
  if (!rp.webhookSecret || !rawBody || !signature) return false;

  const expected = crypto
    .createHmac('sha256', rp.webhookSecret)
    .update(rawBody)
    .digest('hex');

  return safeEqual(expected, signature);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself be a signal.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Fetches a payment from the provider.
 *
 * The reconciliation path: when a client callback and a webhook disagree, or when
 * neither arrived, the provider is the tiebreaker — not the client.
 */
async function fetchPayment(providerPaymentId) {
  const api = getClient();
  try {
    const payment = await api.payments.fetch(providerPaymentId);
    return {
      id: payment.id,
      order_id: payment.order_id,
      status: payment.status,
      amount: Number(payment.amount),
      currency: payment.currency,
      method: payment.method,
      captured: payment.captured === true,
      error_description: payment.error_description || null,
    };
  } catch (err) {
    logger.error({ err: { message: err?.message } }, 'Provider payment fetch failed');
    throw serviceUnavailable('We could not check that payment. Please try again.');
  }
}

/**
 * Every payment attempt made against an order.
 *
 * The reconciliation path when the server never learned a payment id: the app was
 * killed mid-checkout, or the customer finished in an external wallet. An order
 * can carry several attempts — declined, then retried — so the caller looks for a
 * captured one rather than trusting the first.
 */
async function fetchOrderPayments(providerOrderId) {
  const api = getClient();
  try {
    const result = await api.orders.fetchPayments(providerOrderId);
    return (result?.items || []).map((payment) => ({
      id: payment.id,
      order_id: payment.order_id,
      status: payment.status,
      amount: Number(payment.amount),
      currency: payment.currency,
      method: payment.method,
      captured: payment.captured === true || payment.status === 'captured',
    }));
  } catch (err) {
    logger.error({ err: { message: err?.message } }, 'Provider order payments fetch failed');
    throw serviceUnavailable('We could not check that payment. Please try again.');
  }
}

/** Issues a refund. Only called when FEATURE_REFUNDS_ENABLED is on. */
async function createRefund({ providerPaymentId, amountPaise, notes = {} }) {
  const api = getClient();
  try {
    const refund = await api.payments.refund(providerPaymentId, {
      amount: amountPaise,
      speed: 'normal',
      notes,
    });
    return { id: refund.id, status: refund.status, amount: Number(refund.amount) };
  } catch (err) {
    logger.error({ err: { message: err?.message } }, 'Provider refund failed');
    throw internal('The refund could not be processed automatically.', err);
  }
}

module.exports = {
  isConfigured,
  createOrder,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  fetchPayment,
  fetchOrderPayments,
  createRefund,
  // The key id is public — it is embedded in the checkout page. The secret is not
  // and never leaves this module.
  publicKeyId: () => rp.keyId || null,
};
