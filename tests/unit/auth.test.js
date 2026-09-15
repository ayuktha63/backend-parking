'use strict';

/**
 * Authentication primitives.
 *
 * Covers the parts that can be tested without a database. Database-backed flows
 * (OTP consumption, refresh rotation, replay detection) are in tests/contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-at-least-32-characters-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-characters-different';

const { _internal } = require('../../src/services/authService');
const { verifyAccessToken } = require('../../src/middleware/auth');
const { normalisePhone, phone: phoneSchema } = require('../../src/validators/common');

/* ── OTP generation ────────────────────────────────────────────────────────── */

test('generateOtp produces a fixed-length numeric code', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = _internal.generateOtp(6);
    assert.match(code, /^\d{6}$/, `unexpected code: ${code}`);
  }
});

test('generateOtp can produce leading zeros', () => {
  // padStart matters: without it, 1-in-10 codes would be 5 digits.
  const codes = new Set();
  for (let i = 0; i < 4000; i += 1) codes.add(_internal.generateOtp(4));
  assert.ok([...codes].every((c) => c.length === 4));
  assert.ok([...codes].some((c) => c.startsWith('0')), 'expected at least one leading zero');
});

test('generateOtp is not obviously biased', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(_internal.generateOtp(6));
  // 500 draws from 10^6 should essentially never repeat.
  assert.ok(seen.size > 490, `too many collisions: ${seen.size}/500`);
});

/* ── OTP hashing ───────────────────────────────────────────────────────────── */

test('hashOtp binds a code to its request id', () => {
  const a = _internal.hashOtp('123456', 'request-a');
  const b = _internal.hashOtp('123456', 'request-b');
  assert.notEqual(a, b, 'the same code under two request ids must hash differently');
});

test('hashOtp is deterministic for the same inputs', () => {
  assert.equal(_internal.hashOtp('123456', 'r1'), _internal.hashOtp('123456', 'r1'));
});

test('hashOtp does not contain the code', () => {
  const hash = _internal.hashOtp('123456', 'r1');
  assert.ok(!hash.includes('123456'));
  assert.match(hash, /^[0-9a-f]{64}$/);
});

/* ── constant-time comparison ──────────────────────────────────────────────── */

test('safeEqual matches identical strings and rejects everything else', () => {
  assert.equal(_internal.safeEqual('abc', 'abc'), true);
  assert.equal(_internal.safeEqual('abc', 'abd'), false);
  // Different lengths must not throw — timingSafeEqual does if given unequal buffers.
  assert.equal(_internal.safeEqual('abc', 'abcdef'), false);
  assert.equal(_internal.safeEqual('', ''), true);
});

/* ── access tokens ─────────────────────────────────────────────────────────── */

test('an access token round-trips with the expected claims', () => {
  const { token } = _internal.signAccessToken({
    subjectId: 42,
    role: 'customer',
    phone: '9876543210',
  });

  const claims = verifyAccessToken(token);
  assert.equal(claims.sub, '42');
  assert.equal(claims.role, 'customer');
  assert.equal(claims.typ, 'access');
  assert.ok(claims.jti, 'a token id is required so sessions can be revoked');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
});

test('a tampered token is rejected', () => {
  const { token } = _internal.signAccessToken({ subjectId: 1, role: 'customer', phone: '9876543210' });
  const [header, payload, signature] = token.split('.');

  // Escalate the role in the payload and re-assemble with the original signature.
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
  decoded.role = 'owner';
  const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');

  assert.throws(
    () => verifyAccessToken(`${header}.${forgedPayload}.${signature}`),
    (err) => err.code === 'TOKEN_INVALID'
  );
});

test('a token signed with the wrong secret is rejected', () => {
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign(
    { sub: '1', role: 'owner', typ: 'access' },
    'a-completely-different-secret-value-here',
    { issuer: 'parqx', expiresIn: 900 }
  );
  assert.throws(() => verifyAccessToken(forged), (err) => err.code === 'TOKEN_INVALID');
});

test('an expired token reports TOKEN_EXPIRED so the client knows to refresh', () => {
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign(
    { sub: '1', role: 'customer', typ: 'access' },
    process.env.JWT_ACCESS_SECRET,
    { issuer: 'parqx', expiresIn: -10 }
  );
  assert.throws(() => verifyAccessToken(expired), (err) => err.code === 'TOKEN_EXPIRED');
});

test('a refresh-typed token cannot be used as an access token', () => {
  const jwt = require('jsonwebtoken');
  const wrongType = jwt.sign(
    { sub: '1', role: 'customer', typ: 'refresh' },
    process.env.JWT_ACCESS_SECRET,
    { issuer: 'parqx', expiresIn: 900 }
  );
  assert.throws(() => verifyAccessToken(wrongType), (err) => err.code === 'TOKEN_WRONG_TYPE');
});

/* ── phone normalisation ───────────────────────────────────────────────────── */

test('normalisePhone collapses every format users actually type', () => {
  // The old login screen showed a "+91" prefix that was NOT prepended to the value
  // sent, so "+919876543210" and "9876543210" became two different accounts.
  assert.equal(normalisePhone('9876543210'), '9876543210');
  assert.equal(normalisePhone('+919876543210'), '9876543210');
  assert.equal(normalisePhone('+91 98765 43210'), '9876543210');
  assert.equal(normalisePhone('09876543210'), '9876543210');
  assert.equal(normalisePhone('91-9876-543210'), '9876543210');
  assert.equal(normalisePhone('  9876543210  '), '9876543210');
});

test('normalisePhone is safe with junk', () => {
  assert.equal(normalisePhone(null), '');
  assert.equal(normalisePhone(undefined), '');
  assert.equal(normalisePhone('abc'), '');
});

test('the phone schema accepts valid Indian mobiles and rejects the rest', () => {
  assert.equal(phoneSchema.parse('+91 98765 43210'), '9876543210');
  assert.equal(phoneSchema.parse('7012256257'), '7012256257');

  for (const bad of ['1234567890', '98765', '', 'abcdefghij', '5876543210']) {
    assert.throws(() => phoneSchema.parse(bad), `expected "${bad}" to be rejected`);
  }
});

/* ── token hashing ─────────────────────────────────────────────────────────── */

test('refresh tokens are stored hashed, never in the clear', () => {
  const token = 'a'.repeat(64);
  const hash = _internal.hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
  assert.equal(_internal.hashToken(token), hash, 'lookup requires determinism');
});
