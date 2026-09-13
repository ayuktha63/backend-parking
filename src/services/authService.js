'use strict';

/**
 * Authentication.
 *
 * The single most important module in the rewrite: the previous system had no
 * authentication whatsoever. "Login" posted a phone number to an endpoint that
 * could not fail, and every backend route was anonymous, so knowing a phone number
 * was equivalent to being that person.
 *
 * Flow:
 *   requestOtp  → hashed code stored with a TTL and an attempt budget, delivered
 *                 out of band, and NEVER returned in the response in production
 *   verifyOtp   → constant-time compare, single-use consumption, issues tokens
 *   refresh     → rotating refresh tokens with replay detection
 *   logout      → real revocation
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { config } = require('../config');
const db = require('../db');
const { logger, maskPhone } = require('../utils/logger');
const time = require('../utils/time');
const { DomainErrors, unauthorized, badRequest, tooManyRequests, forbidden } = require('../utils/errors');

const userRepository = require('../repositories/userRepository');
const ownerRepository = require('../repositories/ownerRepository');
const otpRepository = require('../repositories/otpRepository');
const tokenRepository = require('../repositories/tokenRepository');
const { getProvider } = require('./otpProvider');

/* ── secrets and hashing ───────────────────────────────────────────────────── */

/**
 * Hashes an OTP with a pepper derived from the refresh secret, so a database dump
 * alone does not allow codes to be brute-forced offline.
 */
function hashOtp(code, requestId) {
  return crypto
    .createHmac('sha256', config.auth.refreshSecret)
    .update(`${requestId}:${code}`)
    .digest('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Timing-safe string comparison. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Cryptographically secure numeric code — not Math.random(), as previously used. */
function generateOtp(length = config.otp.length) {
  const max = 10 ** length;
  const value = crypto.randomInt(0, max);
  return String(value).padStart(length, '0');
}

/* ── token issuing ─────────────────────────────────────────────────────────── */

function signAccessToken({ subjectId, role, phone }) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { sub: String(subjectId), role, phone, typ: 'access', jti },
    config.auth.accessSecret,
    {
      issuer: config.auth.issuer,
      expiresIn: config.auth.accessTtlSeconds,
      algorithm: 'HS256',
    }
  );
  return { token, jti, expiresIn: config.auth.accessTtlSeconds };
}

/**
 * Issues an access token plus a persisted, rotating refresh token.
 * @param {object} subject
 * @param {string|null} familyId continue an existing session family on refresh
 */
async function issueTokens(subject, { familyId = null, deviceLabel = null } = {}, client = null) {
  const { id, role, phone } = subject;

  const access = signAccessToken({ subjectId: id, role, phone });

  // The refresh token is opaque randomness, not a JWT: it has no claims to leak and
  // its authority comes entirely from the database row.
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const expiresAt = time.addSeconds(time.nowUtc(), config.auth.refreshTtlSeconds);

  const stored = await tokenRepository.create(
    {
      userId: role === 'customer' ? id : null,
      ownerId: role === 'owner' ? id : null,
      role,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt,
      deviceLabel,
    },
    client
  );

  return {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    refresh_token: refreshToken,
    refresh_expires_at: time.toIso(expiresAt),
    _tokenId: stored.id,
    _familyId: stored.family_id,
  };
}

/** Strips internal fields before a token bundle reaches a client. */
function publicTokens(bundle) {
  const { _tokenId, _familyId, ...rest } = bundle;
  return rest;
}

/* ── OTP ───────────────────────────────────────────────────────────────────── */

/**
 * Issues and delivers a one-time code.
 *
 * Deliberately does NOT reveal whether the phone number already has an account —
 * the response is identical either way, so this endpoint cannot be used to
 * enumerate customers.
 */
async function requestOtp({ phone, role = 'customer', ip, userAgent }) {
  const purpose = role === 'owner' ? 'owner_login' : 'login';

  // Resend cooldown, on top of the middleware rate limit.
  const latest = await otpRepository.findLatestActive(phone, purpose);
  if (latest) {
    const ageSeconds = time.diffSeconds(time.nowUtc(), latest.created_at);
    if (ageSeconds !== null && ageSeconds < config.otp.resendCooldownSeconds) {
      const wait = config.otp.resendCooldownSeconds - ageSeconds;
      throw tooManyRequests(
        `Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting another code`,
        { retry_after_seconds: wait },
        'OTP_COOLDOWN'
      );
    }
  }

  // Invalidate outstanding codes so only the newest can be used.
  await otpRepository.consumeAllForPhone(phone, purpose);

  const code = generateOtp();
  const expiresAt = time.addSeconds(time.nowUtc(), config.otp.ttlSeconds);

  // The id is part of the hash input, so a code is bound to its request and cannot
  // be replayed against a different one.
  const requestId = crypto.randomUUID();
  const created = await db.queryOne(
    `INSERT INTO otp_requests
       (id, phone, purpose, otp_hash, max_attempts, expires_at, request_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, expires_at`,
    [
      requestId,
      phone,
      purpose,
      hashOtp(code, requestId),
      config.otp.maxAttempts,
      expiresAt,
      ip || null,
      userAgent ? String(userAgent).slice(0, 300) : null,
    ]
  );

  await getProvider().send(phone, code);

  logger.info({ phone: maskPhone(phone), purpose }, 'OTP issued');

  return {
    request_id: created.id,
    expires_at: time.toIso(created.expires_at),
    expires_in: config.otp.ttlSeconds,
    resend_after_seconds: config.otp.resendCooldownSeconds,
    // Development convenience only. Config validation makes this impossible in
    // production — the old implementation shipped it live as `debug_otp`.
    ...(config.otp.exposeInResponse ? { dev_otp: code } : {}),
  };
}

/**
 * Verifies a code and issues tokens.
 *
 * Creates the account on first successful verification, so there is no separate
 * registration step and no way to be "registered but not logged in" — the state the
 * old register screen left users in.
 */
async function verifyOtp({ phone, otp, requestId, name, role = 'customer', deviceLabel }) {
  const purpose = role === 'owner' ? 'owner_login' : 'login';

  const record = await otpRepository.findForVerification(requestId);

  // A missing, mismatched or already-used record is reported identically, so the
  // endpoint cannot be probed for valid request ids.
  if (!record || record.phone !== phone || record.purpose !== purpose) {
    throw DomainErrors.otpInvalid();
  }
  if (record.consumed_at) throw DomainErrors.otpInvalid();
  if (time.isBefore(record.expires_at, time.nowUtc())) throw DomainErrors.otpExpired();
  if (record.attempts >= record.max_attempts) throw DomainErrors.otpTooManyAttempts();

  if (!safeEqual(record.otp_hash, hashOtp(otp, requestId))) {
    const updated = await otpRepository.incrementAttempts(requestId);
    const remaining = Math.max(0, updated.max_attempts - updated.attempts);
    if (remaining === 0) throw DomainErrors.otpTooManyAttempts();
    throw badRequest(
      `That code is not correct. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`,
      { attempts_remaining: remaining },
      'OTP_INVALID'
    );
  }

  // Single-use: a null return means another request consumed it first.
  const consumed = await otpRepository.consume(requestId);
  if (!consumed) throw DomainErrors.otpInvalid();

  return db.withTransaction(async (tx) => {
    let subject;
    let isNew = false;

    if (role === 'owner') {
      const owner = await ownerRepository.createOrGet({ phone, name }, tx);
      isNew = owner.was_created === true;
      if (!owner.is_active) {
        throw forbidden('This operator account has been deactivated', 'ACCOUNT_DEACTIVATED');
      }
      subject = { id: owner.id, role: 'owner', phone: owner.phone, profile: owner };
    } else {
      const user = await userRepository.createOrGet({ phone, name }, tx);
      isNew = user.was_created === true;
      if (!user.is_active) {
        throw forbidden('This account has been deactivated', 'ACCOUNT_DEACTIVATED');
      }
      await userRepository.markLoggedIn(user.id, tx);
      subject = { id: user.id, role: 'customer', phone: user.phone, profile: user };
    }

    const tokens = await issueTokens(subject, { deviceLabel }, tx);

    logger.info(
      { phone: maskPhone(phone), role, isNew, subjectId: subject.id },
      'Authenticated via OTP'
    );

    return {
      ...publicTokens(tokens),
      is_new_account: isNew,
      // A brand-new customer has no name or vehicle yet; the client uses this to
      // decide whether to show the one-time profile step.
      needs_profile: role === 'customer' && (!subject.profile.name || subject.profile.name === 'User'),
      [role === 'owner' ? 'owner' : 'user']: serializeSubject(subject.profile, role),
    };
  });
}

/* ── owner password sign-in ────────────────────────────────────────────────── */

/**
 * Password sign-in, retained for owners who already have one.
 *
 * Two changes from the previous implementation: the password is bcrypt-compared
 * rather than matched with `=` in SQL, and there is no password-optional branch.
 * `POST /api/owner/login {"phone": "..."}` used to return the account, and the
 * owner app's own profile screen relied on that.
 */
async function ownerPasswordLogin({ phone, password, deviceLabel }) {
  // eslint-disable-next-line global-require
  const bcrypt = require('bcryptjs');

  const owner = await ownerRepository.findByPhoneWithSecret(phone);

  // Compare against a dummy hash when the account is absent, so a missing account
  // and a wrong password take the same time and give the same answer.
  const hash = owner?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvaliduO';
  const ok = await bcrypt.compare(password, hash);

  if (!owner || !owner.password_hash || !ok) {
    throw unauthorized('Phone number or password is incorrect', 'INVALID_CREDENTIALS');
  }
  if (!owner.is_active) {
    throw forbidden('This operator account has been deactivated', 'ACCOUNT_DEACTIVATED');
  }

  const subject = { id: owner.id, role: 'owner', phone: owner.phone };
  const tokens = await issueTokens(subject, { deviceLabel });

  logger.info({ ownerId: owner.id }, 'Owner signed in with a password');

  return {
    ...publicTokens(tokens),
    // Every owner migrated from the plaintext era carries this flag; those passwords
    // are in git history and must be treated as disclosed.
    must_reset_password: owner.must_reset_password === true,
    owner: serializeSubject(owner, 'owner'),
  };
}

async function setOwnerPassword({ ownerId, currentPassword, newPassword }) {
  // eslint-disable-next-line global-require
  const bcrypt = require('bcryptjs');

  const owner = await ownerRepository.findByPhoneWithSecret(
    (await ownerRepository.findById(ownerId))?.phone
  );
  if (!owner) throw unauthorized('Sign in again to continue', 'ACCOUNT_MISSING');

  // An owner who already has a usable password must prove it. One flagged for reset
  // is exempt: the whole point is that they cannot be trusted to know it.
  if (owner.password_hash && !owner.must_reset_password) {
    const ok = currentPassword ? await bcrypt.compare(currentPassword, owner.password_hash) : false;
    if (!ok) throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  }

  const hash = await bcrypt.hash(newPassword, config.auth.bcryptRounds);
  await ownerRepository.setPasswordHash(ownerId, hash);

  // Changing a password ends every other session.
  await tokenRepository.revokeAllForSubject({ ownerId }, 'password_changed');

  logger.info({ ownerId }, 'Owner password set');
  return { updated: true };
}

/* ── refresh and logout ────────────────────────────────────────────────────── */

/**
 * Exchanges a refresh token for a new pair.
 *
 * Replay detection: presenting a token that has already been rotated revokes the
 * entire family, because either the legitimate client or an attacker is replaying
 * and ending both sessions is the safe outcome.
 */
async function refresh({ refreshToken, deviceLabel }) {
  const tokenHash = hashToken(refreshToken);

  return db.withTransaction(async (tx) => {
    const existing = await tokenRepository.findByHash(tokenHash, tx);

    if (!existing) throw unauthorized('Please sign in again', 'REFRESH_TOKEN_INVALID');

    if (existing.revoked_at) {
      throw unauthorized('Please sign in again', 'REFRESH_TOKEN_REVOKED');
    }

    if (existing.rotated_to) {
      const revoked = await tokenRepository.revokeFamily(
        existing.family_id,
        'token_reuse_detected',
        tx
      );
      logger.warn(
        { familyId: existing.family_id, revoked },
        'Refresh token replay detected — session family revoked'
      );
      throw unauthorized('Please sign in again', 'REFRESH_TOKEN_REUSED');
    }

    if (time.isBefore(existing.expires_at, time.nowUtc())) {
      throw unauthorized('Your session expired. Please sign in again.', 'REFRESH_TOKEN_EXPIRED');
    }

    const role = existing.role;
    const subjectId = role === 'owner' ? existing.owner_id : existing.user_id;

    const profile =
      role === 'owner'
        ? await ownerRepository.findById(subjectId, tx)
        : await userRepository.findById(subjectId, tx);

    if (!profile || profile.is_active === false) {
      await tokenRepository.revokeFamily(existing.family_id, 'account_inactive', tx);
      throw forbidden('This account is no longer active', 'ACCOUNT_DEACTIVATED');
    }

    const next = await issueTokens(
      { id: subjectId, role, phone: profile.phone },
      { familyId: existing.family_id, deviceLabel: deviceLabel || existing.device_label },
      tx
    );

    // Conditional: a null return means a concurrent refresh already rotated it.
    const rotated = await tokenRepository.markRotated(existing.id, next._tokenId, tx);
    if (!rotated) throw unauthorized('Please sign in again', 'REFRESH_TOKEN_REUSED');

    return publicTokens(next);
  });
}

async function logout({ refreshToken, allDevices, auth }) {
  if (allDevices && auth) {
    const count = await tokenRepository.revokeAllForSubject(
      auth.role === 'owner' ? { ownerId: auth.id } : { userId: auth.id },
      'logout_all'
    );
    logger.info({ role: auth.role, subjectId: auth.id, count }, 'Signed out of all devices');
    return { revoked: count };
  }

  if (!refreshToken) return { revoked: 0 };

  const existing = await tokenRepository.findByHash(hashToken(refreshToken));
  if (!existing) return { revoked: 0 };

  // Only the owner of a token may revoke it.
  if (auth) {
    const subjectId = existing.role === 'owner' ? existing.owner_id : existing.user_id;
    if (existing.role !== auth.role || Number(subjectId) !== Number(auth.id)) {
      throw forbidden('That session does not belong to you', 'NOT_SESSION_OWNER');
    }
  }

  await tokenRepository.revoke(existing.id, 'logout');
  return { revoked: 1 };
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

function serializeSubject(row, role) {
  if (!row) return null;
  const base = {
    id: row.id,
    phone: row.phone,
    name: row.name,
    created_at: time.toIso(row.created_at),
  };
  if (role === 'owner') {
    return { ...base, email: row.email ?? null, must_reset_password: row.must_reset_password === true };
  }
  return {
    ...base,
    phone_verified: row.phone_verified === true,
    onboarded: Boolean(row.onboarded_at),
  };
}

async function getSessions(auth) {
  return tokenRepository.listActiveForSubject(
    auth.role === 'owner' ? { ownerId: auth.id } : { userId: auth.id }
  );
}

module.exports = {
  requestOtp,
  verifyOtp,
  ownerPasswordLogin,
  setOwnerPassword,
  refresh,
  logout,
  getSessions,
  serializeSubject,
  // exported for tests
  _internal: { hashOtp, hashToken, generateOtp, safeEqual, signAccessToken },
};
