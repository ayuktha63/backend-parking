'use strict';

/**
 * Payments.
 *
 * THE RULE: the client never tells the server that a payment succeeded.
 *
 * The old flow was `POST /api/bookings { payment_id: "<any string>" }` and the
 * booking was marked verified. There was no order, no amount the server had chosen,
 * no signature, and no webhook. Anything non-empty was money.
 *
 * The flow now, and the four ways it can be reached:
 *
 *   1. Server creates the order, fixing the amount from the booking.
 *   2. Razorpay Checkout runs on the device.
 *   3a. The device returns order_id/payment_id/signature → verified here by HMAC.
 *   3b. Razorpay calls the webhook → verified here by body HMAC.
 *   3c. Both arrive, in either order → whichever is first settles; the second is a
 *       no-op, because `markPaid` is conditional on the payment not being PAID.
 *   3d. Neither arrives (app killed mid-payment) → `reconcile` asks the provider
 *       for the order's payments; the unpaid-booking sweeper asks the same question
 *       before giving the slot away.
 *
 * In every path the booking reaches CONFIRMED exactly once. And when money is
 * captured for a booking that can no longer be confirmed — it expired, was
 * cancelled, or another payment already confirmed it — the refund owed is
 * recorded in the same transaction. Captured money never goes unaccounted for.
 */

const { config } = require('../config');
const db = require('../db');
const bookingRepository = require('../repositories/bookingRepository');
const paymentRepository = require('../repositories/paymentRepository');
const bookingService = require('./bookingService');
const provider = require('./paymentProvider');
const time = require('../utils/time');
const money = require('../utils/money');
const { logger } = require('../utils/logger');
const {
  notFound,
  forbidden,
  conflict,
  serviceUnavailable,
  DomainErrors,
} = require('../utils/errors');

/** A payment in one of these states has been received and needs no settling. */
const SETTLED_STATUSES = ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'];

/** Booking states a captured payment has already served. */
const PAID_BOOKING_STATUSES = ['CONFIRMED', 'CHECKED_IN', 'COMPLETED'];

/* ── order creation ────────────────────────────────────────────────────────── */

/**
 * Creates (or returns) the payment order for a booking.
 *
 * The amount comes from `bookings.amount_paise`, which was written by the booking
 * service from a server-computed quote. There is no parameter through which a
 * caller could influence it.
 *
 * Idempotent: calling twice for the same booking returns the same open order rather
 * than creating a second one the customer could also pay.
 */
async function createOrderForBooking({ userId, bookingId, idempotencyKey = null }) {
  const booking = await bookingRepository.findByIdForUser({ bookingId, userId });
  if (!booking) throw notFound('That booking could not be found', 'BOOKING_NOT_FOUND');

  if (booking.status === 'CONFIRMED' || booking.payment_status === 'PAID') {
    throw DomainErrors.paymentAlreadySettled();
  }
  if (booking.status !== 'PENDING_PAYMENT') {
    throw conflict(
      `This booking is ${bookingService.serializeBooking(booking).status_label.toLowerCase()} and cannot be paid for`,
      'BOOKING_NOT_PAYABLE',
      { status: booking.status }
    );
  }

  // A booking that has already expired must not be payable. The sweeper will catch
  // it within 30 seconds anyway; this closes the window in between.
  const createdAt = time.parseInstant(booking.created_at);
  const ageSeconds = time.diffSeconds(time.nowUtc(), createdAt) ?? 0;
  if (ageSeconds > config.booking.pendingPaymentSeconds) {
    throw conflict(
      'This booking expired before payment was completed. Please book again.',
      'BOOKING_PAYMENT_WINDOW_EXPIRED'
    );
  }

  if (!provider.isConfigured()) {
    // Honest failure. The alternative — pretending the payment succeeded — is what
    // this entire module exists to prevent.
    throw serviceUnavailable('Payments are not available right now. Please try again shortly.');
  }

  const amountPaise = Number(booking.amount_paise);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    logger.error({ bookingId, amountPaise }, 'Booking has no valid amount; refusing to create an order');
    throw conflict('This booking has no payable amount. Please book again.', 'BOOKING_AMOUNT_INVALID');
  }

  const existing = await paymentRepository.findOpenForBooking(bookingId);
  if (existing && existing.amount_paise === amountPaise && existing.provider_order_id) {
    return serializeOrder({ payment: existing, booking });
  }

  // An open order for a different amount is stale — the window changed under the
  // customer. Close it before opening the correct one, or the unique index refuses.
  if (existing) {
    await paymentRepository.abandonOpenOrders({ bookingId, reason: 'amount_changed' });
  }

  const order = await provider.createOrder({
    amountPaise,
    currency: booking.currency || config.payments.currency,
    receipt: booking.booking_code,
    notes: {
      booking_id: String(bookingId),
      booking_code: booking.booking_code,
      parking_area: String(booking.parking_id),
    },
  });

  // The provider is the authority on the amount it accepted. If it disagrees with
  // us, stop: paying the wrong amount is worse than not paying.
  if (Number(order.amount) !== amountPaise) {
    logger.error({ bookingId, ours: amountPaise, theirs: order.amount }, 'Order amount mismatch');
    throw serviceUnavailable('We could not start the payment. Please try again.');
  }

  const payment = await paymentRepository.createOrder({
    bookingId,
    userId,
    amountPaise,
    currency: order.currency,
    providerOrderId: order.id,
    orderPayload: order,
    idempotencyKey,
  });

  await bookingRepository.recordEvent({
    bookingId,
    eventType: 'payment_order_created',
    actorType: 'system',
    metadata: { payment_id: payment.id, amount_paise: amountPaise, provider_order_id: order.id },
  });

  return serializeOrder({ payment, booking });
}

/**
 * What the client needs to open Checkout.
 *
 * `key_id` is public by design — it is embedded in the checkout page. The secret is
 * never in this object, and the client is never given the amount as an input: it is
 * told what it will be charged, which is a different thing.
 */
function serializeOrder({ payment, booking }) {
  return {
    payment_id: payment.id,
    booking_id: payment.booking_id,
    booking_code: booking?.booking_code ?? null,
    provider: payment.provider,
    provider_order_id: payment.provider_order_id,
    key_id: provider.publicKeyId(),
    amount_paise: payment.amount_paise,
    amount_display: money.formatPaise(payment.amount_paise),
    currency: payment.currency,
    status: payment.status,
    // Prefill, so the customer is not retyping what we already know.
    prefill: {
      name: booking?.user_name ?? null,
      contact: booking?.phone ?? null,
    },
    description: booking?.parking_name
      ? `Parking at ${booking.parking_name}`
      : 'PARQX parking',
    created_at: time.toIso(payment.created_at),
  };
}

/* ── settlement: client callback ───────────────────────────────────────────── */

/**
 * Verifies the result Razorpay Checkout handed back to the device.
 *
 * Failure here means one of: the signature does not match, the payment is for a
 * different order, or the amount differs. Each of those is a reason to refuse, and
 * none of them is a reason to confirm the booking anyway.
 */
async function verifyClientCallback({
  userId,
  bookingId,
  providerOrderId,
  providerPaymentId,
  signature,
}) {
  const booking = await bookingRepository.findByIdForUser({ bookingId, userId });
  if (!booking) throw notFound('That booking could not be found', 'BOOKING_NOT_FOUND');

  const payment = await paymentRepository.findByProviderOrderId(providerOrderId);
  if (!payment) throw notFound('That payment could not be found', 'PAYMENT_NOT_FOUND');
  if (Number(payment.booking_id) !== Number(bookingId)) {
    throw forbidden('That payment belongs to a different booking', 'PAYMENT_BOOKING_MISMATCH');
  }
  if (Number(payment.user_id) !== Number(userId)) {
    throw forbidden('That payment is not yours', 'NOT_YOUR_PAYMENT');
  }

  // Already settled — by the webhook, or by a previous attempt of this same call.
  // Report the outcome with the current booking rather than an error: from the
  // customer's point of view their payment did go through. Whether it bought the
  // booking is a separate question, answered from the booking itself.
  if (SETTLED_STATUSES.includes(payment.status)) {
    return alreadySettled({ payment, bookingId });
  }

  if (config.features.serverPaymentVerification) {
    const ok = provider.verifyCheckoutSignature({
      orderId: providerOrderId,
      paymentId: providerPaymentId,
      signature,
    });

    if (!ok) {
      logger.warn(
        { bookingId, providerOrderId, providerPaymentId },
        'Checkout signature verification FAILED'
      );
      // Recorded, but the payment is NOT marked failed. A result that does not
      // verify says nothing about the order at the gateway: the genuine capture may
      // still arrive by webhook, and it must be able to settle.
      await bookingRepository.recordEvent({
        bookingId,
        eventType: 'payment_verification_failed',
        actorType: 'system',
        metadata: { reason: 'signature_mismatch' },
      });
      throw DomainErrors.paymentVerificationFailed();
    }
  } else {
    // The flag exists only to stage the rollout and is forbidden in production by
    // config validation. Log loudly so nobody discovers this quietly.
    logger.error(
      { bookingId },
      'FEATURE_SERVER_PAYMENT_VERIFICATION is OFF — accepting a payment without verifying its signature'
    );
  }

  return settle({
    payment,
    providerPaymentId,
    signature,
    settledVia: 'client_callback',
    verifyPayload: { provider_order_id: providerOrderId, provider_payment_id: providerPaymentId },
    userId,
  });
}

/**
 * The single settlement path. Every route into "this booking is paid" comes here.
 *
 * `markPaid` is conditional on the payment not already being settled, so this is
 * safe to call from the webhook and the callback simultaneously: exactly one wins,
 * and the loser takes the `already_settled` branch.
 */
async function settle({ payment, providerPaymentId, signature = null, settledVia, verifyPayload = {}, userId = null }) {
  const outcome = await db.withTransaction(async (tx) => {
    // Booking first, then payment — the order cancellation already takes. Locking
    // the payment first deadlocked against a cancel, or against a second order for
    // the same booking being captured at the same moment.
    await bookingRepository.lockById(payment.booking_id, tx);
    const locked = await paymentRepository.lockById(payment.id, tx);
    if (!locked) throw notFound('That payment could not be found', 'PAYMENT_NOT_FOUND');

    const unchanged = { changed: false, paymentId: locked.id, bookingId: locked.booking_id };
    if (SETTLED_STATUSES.includes(locked.status)) return unchanged;

    const paid = await paymentRepository.markPaid(
      {
        paymentId: locked.id,
        providerPaymentId,
        signature,
        verifyPayload,
        settledVia,
      },
      tx
    );

    // Lost the race inside the transaction. Not an error.
    if (!paid) return unchanged;

    await bookingRepository.recordEvent(
      {
        bookingId: locked.booking_id,
        eventType: 'payment_captured',
        actorType: settledVia === 'webhook' ? 'provider' : 'customer',
        actorId: userId,
        metadata: {
          payment_id: locked.id,
          settled_via: settledVia,
          amount_paise: locked.amount_paise,
        },
      },
      tx
    );

    // Same transaction: a payment that is PAID while its booking is still
    // PENDING_PAYMENT is exactly the inconsistency this system exists to avoid.
    const confirmation = await bookingService.confirmPaid({
      bookingId: locked.booking_id,
      paymentId: locked.id,
      actorType: settledVia === 'webhook' ? 'provider' : 'customer',
      client: tx,
    });

    if (confirmation.changed) {
      // Any other order still open for this booking could be paid a second time.
      await paymentRepository.abandonOpenOrders({ bookingId: locked.booking_id, reason: 'booking_paid' }, tx);
      return { changed: true, confirmed: true, paymentId: locked.id, bookingId: locked.booking_id };
    }

    // Money was captured for a booking this payment cannot confirm: another
    // payment already did, or the booking expired or was cancelled first. The
    // customer is owed it back, recorded now, in the same transaction — whether
    // or not refunds are being dispatched yet.
    const status = confirmation.booking?.status;
    const reason = PAID_BOOKING_STATUSES.includes(status) ? 'duplicate_payment' : 'captured_after_booking_closed';
    await paymentRepository.createRefund(
      { paymentId: locked.id, bookingId: locked.booking_id, amountPaise: locked.amount_paise, reason },
      tx
    );
    await bookingRepository.recordEvent(
      {
        bookingId: locked.booking_id,
        eventType: 'payment_refund_due',
        actorType: 'system',
        metadata: { payment_id: locked.id, reason, amount_paise: locked.amount_paise, booking_status: status },
      },
      tx
    );
    logger.warn(
      { bookingId: locked.booking_id, paymentId: locked.id, reason, bookingStatus: status },
      'Payment captured for a booking it cannot confirm; refund recorded'
    );
    return { changed: true, confirmed: false, refundDue: true, paymentId: locked.id, bookingId: locked.booking_id };
  });

  if (!outcome.changed) return alreadySettled({ payment, bookingId: outcome.bookingId });

  const booking = await bookingRepository.findByIdUnscoped(outcome.bookingId);
  return {
    verified: true,
    already_settled: false,
    confirmed: outcome.confirmed,
    refund_due: Boolean(outcome.refundDue),
    booking: bookingService.serializeBooking(booking),
  };
}

/**
 * The answer for a payment that was settled earlier: what the booking is now, and
 * whether this payment is owed back.
 */
async function alreadySettled({ payment, bookingId }) {
  const booking = await bookingRepository.findByIdUnscoped(bookingId);
  const refund = await paymentRepository.findRefundForPayment(payment.id);
  return {
    verified: true,
    already_settled: true,
    confirmed: PAID_BOOKING_STATUSES.includes(booking?.status) && !refund,
    refund_due: Boolean(refund),
    booking: bookingService.serializeBooking(booking),
  };
}

/**
 * Records a failed or abandoned payment attempt.
 *
 * The booking stays PENDING_PAYMENT so the customer can retry until the payment
 * window closes. It is never cancelled here: a failed card is not a decision to
 * give up the slot.
 */
async function recordClientFailure({ userId, bookingId, providerOrderId, reason }) {
  const booking = await bookingRepository.findByIdForUser({ bookingId, userId });
  if (!booking) throw notFound('That booking could not be found', 'BOOKING_NOT_FOUND');

  const payment = providerOrderId
    ? await paymentRepository.findByProviderOrderId(providerOrderId)
    : await paymentRepository.findOpenForBooking(bookingId);

  if (payment && Number(payment.booking_id) === Number(bookingId) && !SETTLED_STATUSES.includes(payment.status)) {
    await paymentRepository.markFailed({
      paymentId: payment.id,
      reason: reason || 'cancelled_by_user',
      payload: { source: 'client' },
    });
  }

  await bookingRepository.recordEvent({
    bookingId,
    eventType: 'payment_failed',
    actorType: 'customer',
    actorId: userId,
    metadata: { reason: String(reason || 'cancelled_by_user').slice(0, 200) },
  });

  const current = await bookingRepository.findByIdForUser({ bookingId, userId });

  return {
    booking: bookingService.serializeBooking(current),
    // How long they have left to retry before the sweeper releases the slot.
    retry_seconds_remaining: Math.max(
      0,
      config.booking.pendingPaymentSeconds -
        (time.diffSeconds(time.nowUtc(), time.parseInstant(current.created_at)) ?? 0)
    ),
  };
}

/* ── settlement: webhook ───────────────────────────────────────────────────── */

/**
 * Processes a provider webhook.
 *
 * Three layers of protection, in order:
 *   1. Body HMAC — an unsigned request is rejected before anything is read.
 *   2. `claimWebhookEvent` — a replayed delivery is recognised and dropped.
 *   3. `markPaid` conditional — even a genuinely new event cannot double-settle.
 *
 * Always returns 2xx-shaped output for a signed, well-formed request, including for
 * events we do not handle. A provider that receives an error retries, and retrying
 * something we deliberately ignore is noise forever.
 */
async function handleWebhook({ rawBody, signature, parsedBody }) {
  if (!provider.verifyWebhookSignature({ rawBody, signature })) {
    logger.warn('Webhook signature verification FAILED — rejected');
    throw forbidden('Invalid webhook signature', 'WEBHOOK_SIGNATURE_INVALID');
  }

  const body = parsedBody || {};
  const eventType = body.event;

  // Razorpay does not send a stable event id in the body on every plan, so the
  // payment/order id plus the event name is used as the dedupe key. It is stable
  // for the thing we actually care about: this payment, this transition.
  const entity =
    body.payload?.payment?.entity || body.payload?.order?.entity || body.payload?.refund?.entity || {};
  const eventId = `${eventType}:${entity.id || body.created_at || Date.now()}`;

  const claim = await paymentRepository.claimWebhookEvent({
    eventId,
    eventType,
    payload: body,
  });

  if (!claim) {
    logger.debug({ eventId }, 'Duplicate webhook ignored');
    return { handled: false, reason: 'duplicate' };
  }

  try {
    const result = await routeWebhookEvent({ eventType, entity, body });
    await paymentRepository.markWebhookProcessed({ id: claim.id });
    return { handled: true, event: eventType, ...result };
  } catch (err) {
    await paymentRepository.markWebhookProcessed({ id: claim.id, error: err?.message });
    logger.error({ err, eventType, eventId }, 'Webhook processing failed');
    // Re-thrown so the provider retries a genuine server-side failure.
    throw err;
  }
}

async function routeWebhookEvent({ eventType, entity }) {
  switch (eventType) {
    case 'payment.captured':
    case 'order.paid':
      return webhookPaymentCaptured(entity);

    case 'payment.failed':
      return webhookPaymentFailed(entity);

    case 'refund.processed':
      return webhookRefundProcessed(entity);

    default:
      logger.debug({ eventType }, 'Webhook event not handled');
      return { action: 'ignored' };
  }
}

async function webhookPaymentCaptured(entity) {
  const orderId = entity.order_id || entity.id;
  const payment = await paymentRepository.findByProviderOrderId(orderId);

  if (!payment) {
    // A captured payment with no matching order is a genuine anomaly: money has
    // moved for something we have no record of. Loud, and not silently swallowed.
    logger.error({ orderId, paymentId: entity.id }, 'Webhook: captured payment has no matching order');
    return { action: 'unmatched_order' };
  }

  // The provider's amount is authoritative. A mismatch means something is wrong
  // upstream and must not be auto-confirmed.
  if (entity.amount !== undefined && Number(entity.amount) !== Number(payment.amount_paise)) {
    logger.error(
      { paymentId: payment.id, ours: payment.amount_paise, theirs: entity.amount },
      'Webhook: amount mismatch — refusing to settle'
    );
    return { action: 'amount_mismatch' };
  }

  const result = await settle({
    payment,
    providerPaymentId: entity.id,
    settledVia: 'webhook',
    verifyPayload: { source: 'webhook', provider_payment_id: entity.id },
  });

  if (result.already_settled) return { action: 'already_settled' };
  return { action: result.confirmed ? 'confirmed' : 'refund_due' };
}

async function webhookPaymentFailed(entity) {
  const payment = await paymentRepository.findByProviderOrderId(entity.order_id);
  if (!payment || payment.settled_at) return { action: 'ignored' };

  await paymentRepository.markFailed({
    paymentId: payment.id,
    reason: entity.error_description || entity.error_reason || 'payment_failed',
    payload: { source: 'webhook', provider_payment_id: entity.id },
    settledVia: 'webhook',
  });

  await bookingRepository.recordEvent({
    bookingId: payment.booking_id,
    eventType: 'payment_failed',
    actorType: 'provider',
    metadata: { reason: entity.error_description || 'payment_failed' },
  });

  return { action: 'marked_failed' };
}

async function webhookRefundProcessed(entity) {
  const payment = await paymentRepository.findByProviderPaymentId(entity.payment_id);
  if (!payment) return { action: 'unmatched_payment' };

  await db.withTransaction(async (tx) => {
    await paymentRepository.addRefundedAmount(
      { paymentId: payment.id, amountPaise: Number(entity.amount) },
      tx
    );
    await bookingRepository.recordEvent(
      {
        bookingId: payment.booking_id,
        eventType: 'refund_processed',
        actorType: 'provider',
        metadata: { amount_paise: Number(entity.amount), provider_refund_id: entity.id },
      },
      tx
    );
  });

  return { action: 'refund_recorded' };
}

/* ── reconciliation ────────────────────────────────────────────────────────── */

/**
 * Asks the provider what actually happened.
 *
 * The path for the case neither callback nor webhook covers: the app was killed
 * during checkout, or the customer finished in an external wallet, so the device
 * never reported back and the webhook has not arrived (or the deployment has none
 * configured). Called when the customer reopens a booking that is still
 * PENDING_PAYMENT.
 */
async function reconcile({ userId, bookingId }) {
  const booking = await bookingRepository.findByIdForUser({ bookingId, userId });
  if (!booking) throw notFound('That booking could not be found', 'BOOKING_NOT_FOUND');
  return reconcileBooking({ booking, userId });
}

/**
 * Settles a pending booking from the gateway's own record of its orders.
 *
 * Asks about ORDERS, not payment ids. The server learns a payment id only from the
 * callback or the webhook — precisely the two things missing in the cases this
 * exists for — so asking about a known payment id could never find anything.
 *
 * Also run by the unpaid-booking sweeper before it expires a booking, so a customer
 * who paid is not handed an expired booking because a webhook was late.
 */
async function reconcileBooking({ booking, bookingId, userId = null }) {
  const current = booking || (await bookingRepository.findByIdUnscoped(bookingId));
  if (!current) throw notFound('That booking could not be found', 'BOOKING_NOT_FOUND');
  const serialize = (row) => bookingService.serializeBooking(row);

  if (current.status !== 'PENDING_PAYMENT') {
    return { reconciled: false, reason: 'not_pending', booking: serialize(current) };
  }
  if (!provider.isConfigured()) {
    return { reconciled: false, reason: 'provider_unavailable', booking: serialize(current) };
  }

  const orders = await paymentRepository.listUnpaidOrdersForBooking(current.id);
  if (orders.length === 0) {
    return { reconciled: false, reason: 'no_order', booking: serialize(current) };
  }

  for (const payment of orders) {
    const attempts = await provider.fetchOrderPayments(payment.provider_order_id);
    // Amount checked against our order, not taken from the gateway response.
    const captured = attempts.find(
      (attempt) => attempt.captured && Number(attempt.amount) === Number(payment.amount_paise)
    );
    if (!captured) continue;

    const result = await settle({
      payment,
      providerPaymentId: captured.id,
      settledVia: 'reconciliation',
      verifyPayload: { source: 'reconciliation', remote_status: captured.status },
      userId,
    });
    return {
      reconciled: result.confirmed,
      reason: result.confirmed ? null : 'refund_due',
      refund_due: result.refund_due,
      booking: result.booking,
    };
  }

  const latest = await bookingRepository.findByIdUnscoped(current.id);
  return { reconciled: false, reason: 'not_captured', booking: serialize(latest) };
}

/* ── status ────────────────────────────────────────────────────────────────── */

/** Payment state for one booking, for the "checking your payment" screen. */
async function getStatus({ userId, bookingId }) {
  const booking = await bookingRepository.findByIdForUser({ bookingId, userId });
  if (!booking) throw notFound('That booking could not be found', 'BOOKING_NOT_FOUND');

  const payment =
    (await paymentRepository.findPaidForBooking(bookingId)) ||
    (await paymentRepository.findOpenForBooking(bookingId));

  return {
    booking_id: bookingId,
    booking_status: booking.status,
    payment_status: payment?.status ?? null,
    is_paid: payment?.status === 'PAID',
    amount_paise: payment?.amount_paise ?? booking.amount_paise ?? 0,
    amount_display: money.formatPaise(payment?.amount_paise ?? booking.amount_paise ?? 0),
    reference: payment?.provider_payment_id ?? null,
    settled_at: payment?.settled_at ? time.toIso(payment.settled_at) : null,
    settled_via: payment?.settled_via ?? null,
  };
}

/**
 * Dispatches refunds that are recorded but not yet sent to the provider.
 *
 * Runs as a job. Separating "owe the money" from "send the money" means a gateway
 * outage delays a refund rather than losing the record that one is due.
 */
async function dispatchPendingRefunds({ limit = 20 } = {}) {
  if (!config.features.refundsEnabled) return { affected: 0, skipped: 'feature_disabled' };
  if (!provider.isConfigured()) return { affected: 0, skipped: 'provider_unavailable' };

  const pending = await db.queryMany(
    `SELECT r.id, r.amount_paise, r.booking_id, r.payment_id, p.provider_payment_id
       FROM refunds r
       JOIN payments p ON p.id = r.payment_id
      WHERE r.status = 'PENDING'
        AND p.provider_payment_id IS NOT NULL
      ORDER BY r.created_at ASC
      LIMIT $1`,
    [limit]
  );

  let affected = 0;

  for (const refund of pending) {
    try {
      await db.query(`UPDATE refunds SET status = 'PROCESSING' WHERE id = $1`, [refund.id]);

      const result = await provider.createRefund({
        providerPaymentId: refund.provider_payment_id,
        amountPaise: refund.amount_paise,
        notes: { booking_id: String(refund.booking_id) },
      });

      await db.withTransaction(async (tx) => {
        await paymentRepository.markRefundProcessed(
          { refundId: refund.id, providerRefundId: result.id, status: 'COMPLETED', payload: result },
          tx
        );
        await paymentRepository.addRefundedAmount(
          { paymentId: refund.payment_id, amountPaise: refund.amount_paise },
          tx
        );
        await bookingRepository.recordEvent(
          {
            bookingId: refund.booking_id,
            eventType: 'refund_processed',
            actorType: 'system',
            metadata: { amount_paise: refund.amount_paise, provider_refund_id: result.id },
          },
          tx
        );
      });

      affected += 1;
    } catch (err) {
      // Back to PENDING: the obligation survives the failure and is retried.
      await paymentRepository.markRefundProcessed({
        refundId: refund.id,
        status: 'PENDING',
        failureReason: err?.message?.slice(0, 300),
      });
      logger.error({ err, refundId: refund.id }, 'Refund dispatch failed; will retry');
    }
  }

  return { affected };
}

module.exports = {
  createOrderForBooking,
  verifyClientCallback,
  recordClientFailure,
  handleWebhook,
  reconcile,
  reconcileBooking,
  getStatus,
  dispatchPendingRefunds,
  isConfigured: provider.isConfigured,
};
