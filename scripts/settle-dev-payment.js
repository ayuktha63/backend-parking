#!/usr/bin/env node
/**
 * DEVELOPMENT PAYMENT SETTLEMENT — simulates the PROVIDER, not the settlement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHAT IT DOES NOT DO
 *
 * `paymentProvider.js` says it plainly at the top: "Deliberately absent: a mock
 * provider that returns success when no keys are configured." Without Razorpay
 * credentials `POST /payments/order` returns 503 and the app shows an honest
 * "payment not available" state. That is correct and this script does not
 * change it.
 *
 * But everything DOWNSTREAM of payment — check-in, active parking, check-out,
 * receipt — needs a CONFIRMED booking to exist before it can be tested at all.
 *
 * So this script simulates exactly one thing: the bytes Razorpay would send.
 * It writes the payment row the order endpoint would have written, then posts a
 * genuinely HMAC-SHA256-signed `payment.captured` webhook to the real endpoint.
 *
 * Everything after that is the product's own code, unmodified:
 *   · signature verification (a wrong secret is rejected — try it)
 *   · webhook event de-duplication
 *   · the payment PENDING → PAID transition
 *   · the booking PENDING_PAYMENT → CONFIRMED transition
 *   · slot occupancy and the realtime events that follow
 *
 * What is therefore NOT verified by this: the gateway round trip, the checkout
 * SDK, and the app's own order-creation call. Those need real credentials, and
 * no amount of local scripting substitutes for them.
 *
 * SAFETY: refuses to run against anything but a local dev/test database.
 *
 * USAGE
 *   node scripts/settle-dev-payment.js <bookingId>
 */

'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');

const BOOKING_ID = Number(process.argv[2]);
const API = process.env.API || 'http://localhost:3939/api/v1';
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'local-only-webhook-secret';

function assertLocal(connectionString) {
  const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/?]*)\/([^?]+)(?:\?(.*))?$/i.exec(connectionString);
  if (!m) throw new Error('Could not parse DATABASE_URL.');
  const [, hostPart, rawName, query = ''] = m;
  const name = decodeURIComponent(rawName);
  const socketHost = /(?:^|&)host=([^&]*)/.exec(query)?.[1] ?? '';
  const host = decodeURIComponent(hostPart || socketHost);
  const local =
    host === '' || host === 'localhost' || host === '127.0.0.1' || host.startsWith('/');
  if (!/test|dev|local/i.test(name) || !local) {
    throw new Error(`Refusing to run against "${name}" on "${host}".`);
  }
}

async function main() {
  if (!Number.isInteger(BOOKING_ID)) {
    throw new Error('Usage: node scripts/settle-dev-payment.js <bookingId>');
  }

  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://parqx@/parqx_test?host=/tmp/parqx-pg/sock&port=55432';
  assertLocal(connectionString);

  const pool = new Pool({ connectionString });
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, status, amount_paise, currency, booking_code
         FROM bookings WHERE id = $1`,
      [BOOKING_ID],
    );
    if (rows.length === 0) throw new Error(`Booking ${BOOKING_ID} does not exist.`);
    const booking = rows[0];

    if (booking.status !== 'PENDING_PAYMENT') {
      console.log(`Booking ${BOOKING_ID} is ${booking.status}; nothing to settle.`);
      return;
    }

    // Reuse the booking's existing order if one is already there.
    //
    // `payments` is unique per booking, so a blind insert is silently dropped by
    // ON CONFLICT — and then the webhook is signed for an order id that is not
    // the one in the table, and the handler correctly reports `unmatched_order`.
    // (Which it did, on the first run of this script.)
    const existing = await pool.query(
      'SELECT provider_order_id FROM payments WHERE booking_id = $1 LIMIT 1',
      [booking.id],
    );

    const orderId =
      existing.rows[0]?.provider_order_id ||
      `order_dev${crypto.randomBytes(7).toString('hex')}`;
    const paymentId = `pay_dev${crypto.randomBytes(7).toString('hex')}`;

    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO payments
           (booking_id, user_id, provider, amount_paise, currency, status,
            provider_order_id, order_payload, verify_payload)
         VALUES ($1,$2,'razorpay',$3,$4,'CREATED',$5,$6::jsonb,'{}'::jsonb)`,
        [
          booking.id,
          booking.user_id,
          booking.amount_paise,
          booking.currency || 'INR',
          orderId,
          JSON.stringify({ id: orderId, amount: booking.amount_paise, source: 'dev-settle' }),
        ],
      );
    }

    // The bytes Razorpay would post. Signed for real — the endpoint verifies it.
    const event = {
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            amount: booking.amount_paise,
            currency: booking.currency || 'INR',
            status: 'captured',
            method: 'dev',
          },
        },
      },
    };

    const rawBody = JSON.stringify(event);
    const signature = crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');

    const response = await fetch(`${API}/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signature,
      },
      body: rawBody,
    });

    const text = await response.text();
    console.log(`webhook → HTTP ${response.status} ${text.slice(0, 160)}`);

    const after = await pool.query('SELECT status FROM bookings WHERE id = $1', [BOOKING_ID]);
    console.log(
      `booking ${BOOKING_ID} (${booking.booking_code}): ` +
        `${booking.status} → ${after.rows[0].status}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('settle failed:', e.message);
  process.exit(1);
});
