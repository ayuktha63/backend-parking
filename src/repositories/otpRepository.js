'use strict';

/**
 * One-time passcodes.
 *
 * Replaces `app.locals.otpStore = {}` — a plain in-process object with no expiry,
 * no attempt limit, no rate limit, and whose contents were returned to the caller
 * in the HTTP response as `debug_otp`.
 *
 * The code itself is never stored: only a salted hash, so a database read does not
 * hand over live credentials.
 */

const db = require('../db');
const { config } = require('../config');

const COLUMNS = `
  id, phone, purpose, attempts, max_attempts, expires_at, consumed_at, created_at
`;

async function create(
  { phone, purpose, otpHash, expiresAt, requestIp, userAgent },
  client = null
) {
  return db.queryOne(
    `INSERT INTO otp_requests
       (phone, purpose, otp_hash, max_attempts, expires_at, request_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      phone,
      purpose,
      otpHash,
      config.otp.maxAttempts,
      expiresAt,
      requestIp || null,
      userAgent ? String(userAgent).slice(0, 300) : null,
    ],
    client
  );
}

/** Fetches a request by id, including the hash, for verification only. */
async function findForVerification(requestId, client = null) {
  return db.queryOne(
    `SELECT ${COLUMNS}, otp_hash FROM otp_requests WHERE id = $1`,
    [requestId],
    client
  );
}

/** The most recent unconsumed request for a phone — powers the resend cooldown. */
async function findLatestActive(phone, purpose, client = null) {
  return db.queryOne(
    `SELECT ${COLUMNS} FROM otp_requests
      WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [phone, purpose],
    client
  );
}

async function incrementAttempts(requestId, client = null) {
  return db.queryOne(
    `UPDATE otp_requests
        SET attempts = attempts + 1
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [requestId],
    client
  );
}

/**
 * Marks a code used. Conditional on it still being unconsumed, so the returned row
 * is proof of exclusive consumption — two concurrent verifications cannot both win.
 */
async function consume(requestId, client = null) {
  return db.queryOne(
    `UPDATE otp_requests
        SET consumed_at = NOW()
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING ${COLUMNS}`,
    [requestId],
    client
  );
}

/** Invalidates any outstanding codes for a phone when a new one is issued. */
async function consumeAllForPhone(phone, purpose, client = null) {
  await db.query(
    `UPDATE otp_requests
        SET consumed_at = NOW()
      WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [phone, purpose],
    client
  );
}

/** Housekeeping: removes rows well past expiry. Called by the maintenance job. */
async function purgeExpired(olderThanHours = 24, client = null) {
  const res = await db.query(
    `DELETE FROM otp_requests
      WHERE expires_at < NOW() - ($1 || ' hours')::interval`,
    [olderThanHours],
    client
  );
  return res.rowCount;
}

/** Requests issued to a phone in the last hour — a second line of defence behind rate limiting. */
async function countRecent(phone, purpose, minutes = 60, client = null) {
  const row = await db.queryOne(
    `SELECT COUNT(*)::int AS c FROM otp_requests
      WHERE phone = $1 AND purpose = $2
        AND created_at > NOW() - ($3 || ' minutes')::interval`,
    [phone, purpose, minutes],
    client
  );
  return row?.c ?? 0;
}

module.exports = {
  create,
  findForVerification,
  findLatestActive,
  incrementAttempts,
  consume,
  consumeAllForPhone,
  purgeExpired,
  countRecent,
};
