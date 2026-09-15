'use strict';

/**
 * Payment verification.
 *
 * The signature check is the entire basis on which PARQX believes a payment
 * happened. The system it replaces accepted any non-empty string as proof, so
 * these tests guard the single most security-relevant function in the codebase.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// The provider reads its secret from config at require time, so the environment
// must be set before the module is loaded.
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_unit_dummy';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'unit-test-secret-not-real';
process.env.RAZORPAY_WEBHOOK_SECRET =
  process.env.RAZORPAY_WEBHOOK_SECRET || 'unit-test-webhook-secret';

const provider = require('../../src/services/paymentProvider');

const SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

function signCheckout(orderId, paymentId) {
  return crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

/* ── checkout signature ────────────────────────────────────────────────────── */

test('a correctly signed checkout result verifies', () => {
  const orderId = 'order_ABC123';
  const paymentId = 'pay_XYZ789';

  assert.equal(
    provider.verifyCheckoutSignature({
      orderId,
      paymentId,
      signature: signCheckout(orderId, paymentId),
    }),
    true
  );
});

test('a tampered payment id fails verification', () => {
  const orderId = 'order_ABC123';
  const signature = signCheckout(orderId, 'pay_XYZ789');

  assert.equal(
    provider.verifyCheckoutSignature({ orderId, paymentId: 'pay_DIFFERENT', signature }),
    false
  );
});

test('a tampered order id fails verification', () => {
  const paymentId = 'pay_XYZ789';
  const signature = signCheckout('order_ABC123', paymentId);

  assert.equal(
    provider.verifyCheckoutSignature({ orderId: 'order_OTHER', paymentId, signature }),
    false
  );
});

test('an arbitrary string is not a signature', () => {
  // This is exactly what the old system accepted as proof of payment.
  for (const junk of ['x', 'true', 'paid', '1', 'a'.repeat(64)]) {
    assert.equal(
      provider.verifyCheckoutSignature({
        orderId: 'order_ABC123',
        paymentId: 'pay_XYZ789',
        signature: junk,
      }),
      false,
      `"${junk.slice(0, 12)}" must not verify`
    );
  }
});

test('missing fields fail closed rather than throwing', () => {
  const cases = [
    { orderId: null, paymentId: 'p', signature: 's' },
    { orderId: 'o', paymentId: null, signature: 's' },
    { orderId: 'o', paymentId: 'p', signature: null },
    {},
  ];
  for (const args of cases) {
    assert.equal(provider.verifyCheckoutSignature(args), false);
  }
});

test('signature comparison does not throw on a length mismatch', () => {
  // timingSafeEqual throws when buffers differ in length; the wrapper must handle
  // that rather than turning a failed verification into a 500.
  assert.doesNotThrow(() =>
    provider.verifyCheckoutSignature({
      orderId: 'order_ABC123',
      paymentId: 'pay_XYZ789',
      signature: 'short',
    })
  );
});

/* ── webhook signature ─────────────────────────────────────────────────────── */

test('a webhook signed over the exact body verifies', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: {} }));
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

  assert.equal(provider.verifyWebhookSignature({ rawBody, signature }), true);
});

test('a webhook body altered after signing fails', () => {
  const original = Buffer.from(JSON.stringify({ event: 'payment.captured', amount: 100 }));
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(original).digest('hex');

  const altered = Buffer.from(JSON.stringify({ event: 'payment.captured', amount: 999999 }));
  assert.equal(provider.verifyWebhookSignature({ rawBody: altered, signature }), false);
});

test('re-serialised JSON does not verify, which is why rawBody is retained', () => {
  // Key order and whitespace differ after a parse/stringify round trip, so the
  // HMAC no longer matches. app.js keeps the raw bytes for this reason.
  const body = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1' } } } };
  const rawBody = Buffer.from(JSON.stringify(body, null, 2));
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

  const reserialised = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString())));
  assert.equal(provider.verifyWebhookSignature({ rawBody: reserialised, signature }), false);
});

test('an unsigned webhook is rejected', () => {
  const rawBody = Buffer.from('{}');
  assert.equal(provider.verifyWebhookSignature({ rawBody, signature: undefined }), false);
  assert.equal(provider.verifyWebhookSignature({ rawBody, signature: '' }), false);
});

/* ── configuration ─────────────────────────────────────────────────────────── */

test('the public key id is exposed and the secret is not', () => {
  assert.equal(provider.publicKeyId(), process.env.RAZORPAY_KEY_ID);

  const exported = JSON.stringify(Object.keys(provider));
  assert.ok(!exported.includes('keySecret'), 'the module must not export its secret');
  assert.ok(!exported.includes('webhookSecret'));
});

test('isConfigured reflects whether credentials are present', () => {
  assert.equal(provider.isConfigured(), true, 'set by this test file');
});
