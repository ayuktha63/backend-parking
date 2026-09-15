'use strict';

/**
 * Refresh tokens — revocable sessions.
 *
 * The previous system had no sessions at all, so there was nothing to revoke and
 * no way to sign a device out.
 *
 * Tokens are stored hashed and rotate on every use. Presenting a token that has
 * already been rotated is treated as theft: the whole token family is revoked, on
 * the basis that either the legitimate client or an attacker is replaying, and
 * ending both sessions is the safe outcome.
 */

const db = require('../db');

const COLUMNS = `
  id, user_id, owner_id, role, family_id, rotated_to, revoked_at, revoked_reason,
  expires_at, last_used_at, device_label, created_at
`;

async function create(
  { userId, ownerId, role, tokenHash, familyId, expiresAt, deviceLabel },
  client = null
) {
  return db.queryOne(
    `INSERT INTO refresh_tokens
       (user_id, owner_id, role, token_hash, family_id, expires_at, device_label)
     VALUES ($1, $2, $3, $4, COALESCE($5, gen_random_uuid()), $6, $7)
     RETURNING ${COLUMNS}`,
    [
      userId ?? null,
      ownerId ?? null,
      role,
      tokenHash,
      familyId ?? null,
      expiresAt,
      deviceLabel ? String(deviceLabel).slice(0, 60) : null,
    ],
    client
  );
}

async function findByHash(tokenHash, client = null) {
  return db.queryOne(
    `SELECT ${COLUMNS} FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
    client
  );
}

/**
 * Marks a token rotated. Conditional on it not already being rotated or revoked, so
 * the returned row proves this caller won the race. A null return means the token
 * was replayed.
 */
async function markRotated(id, newTokenId, client = null) {
  return db.queryOne(
    `UPDATE refresh_tokens
        SET rotated_to = $2, last_used_at = NOW()
      WHERE id = $1 AND rotated_to IS NULL AND revoked_at IS NULL
      RETURNING ${COLUMNS}`,
    [id, newTokenId],
    client
  );
}

async function revoke(id, reason, client = null) {
  return db.queryOne(
    `UPDATE refresh_tokens
        SET revoked_at = NOW(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING ${COLUMNS}`,
    [id, reason || 'logout'],
    client
  );
}

/** Revokes every token descended from one login. Used on replay detection. */
async function revokeFamily(familyId, reason, client = null) {
  const res = await db.query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW(), revoked_reason = $2
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason || 'token_reuse_detected'],
    client
  );
  return res.rowCount;
}

/** Signs an account out everywhere. */
async function revokeAllForSubject({ userId, ownerId }, reason, client = null) {
  const res = await db.query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW(), revoked_reason = $3
      WHERE revoked_at IS NULL
        AND ((user_id = $1 AND $1 IS NOT NULL) OR (owner_id = $2 AND $2 IS NOT NULL))`,
    [userId ?? null, ownerId ?? null, reason || 'logout_all'],
    client
  );
  return res.rowCount;
}

/** Active sessions, for a "signed-in devices" screen. */
async function listActiveForSubject({ userId, ownerId }, client = null) {
  return db.queryMany(
    `SELECT id, device_label, created_at, last_used_at, expires_at
       FROM refresh_tokens
      WHERE revoked_at IS NULL
        AND rotated_to IS NULL
        AND expires_at > NOW()
        AND ((user_id = $1 AND $1 IS NOT NULL) OR (owner_id = $2 AND $2 IS NOT NULL))
      ORDER BY COALESCE(last_used_at, created_at) DESC`,
    [userId ?? null, ownerId ?? null],
    client
  );
}

/** Housekeeping: drops tokens long past expiry. */
async function purgeExpired(olderThanDays = 60, client = null) {
  const res = await db.query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < NOW() - ($1 || ' days')::interval`,
    [olderThanDays],
    client
  );
  return res.rowCount;
}

module.exports = {
  create,
  findByHash,
  markRotated,
  revoke,
  revokeFamily,
  revokeAllForSubject,
  listActiveForSubject,
  purgeExpired,
};
