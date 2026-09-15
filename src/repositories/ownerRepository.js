'use strict';

/**
 * Owners (parking operators).
 *
 * Replaces the `register_login` table, whose name was a MongoDB-era artefact and
 * whose `password` column held plaintext compared with `=` in SQL.
 */

const db = require('../db');

const OWNER_COLUMNS = `
  id, phone, name, email, must_reset_password, is_active, created_at, updated_at
`;

/** Never selects password_hash unless explicitly asked for. */
async function findById(id, client = null) {
  return db.queryOne(`SELECT ${OWNER_COLUMNS} FROM owners WHERE id = $1`, [id], client);
}

async function findByPhone(phone, client = null) {
  return db.queryOne(`SELECT ${OWNER_COLUMNS} FROM owners WHERE phone = $1`, [phone], client);
}

/**
 * Used only by the password sign-in path. Kept as a separate function so that
 * `password_hash` can never leak into a response by accident: no other query in
 * the codebase selects it.
 */
async function findByPhoneWithSecret(phone, client = null) {
  return db.queryOne(
    `SELECT ${OWNER_COLUMNS}, password_hash FROM owners WHERE phone = $1`,
    [phone],
    client
  );
}

async function createOrGet({ phone, name }, client = null) {
  return db.queryOne(
    `INSERT INTO owners (phone, name, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (phone) DO UPDATE
       SET name = COALESCE(owners.name, EXCLUDED.name),
           updated_at = NOW()
     RETURNING ${OWNER_COLUMNS}, (xmax = 0) AS was_created`,
    [phone, name ?? null],
    client
  );
}

async function setPasswordHash(id, hash, client = null) {
  return db.queryOne(
    `UPDATE owners
        SET password_hash = $2, must_reset_password = false, updated_at = NOW()
      WHERE id = $1
      RETURNING ${OWNER_COLUMNS}`,
    [id, hash],
    client
  );
}

async function updateProfile(id, { name, email }, client = null) {
  return db.queryOne(
    `UPDATE owners
        SET name = COALESCE($2, name),
            email = COALESCE($3, email),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${OWNER_COLUMNS}`,
    [id, name ?? null, email ?? null],
    client
  );
}

/**
 * Ownership check used by every /owner route that addresses a parking area.
 *
 * The previous system had no such check at all: `POST /api/owner/parking_areas`
 * located a lot by `WHERE name = $1`, so any anonymous caller who knew a lot's name
 * could rewrite its capacity — which deleted every booking in it.
 */
async function ownsParkingArea(ownerId, parkingAreaId, client = null) {
  const row = await db.queryOne(
    `SELECT 1 AS ok FROM parking_areas WHERE id = $1 AND owner_id = $2`,
    [parkingAreaId, ownerId],
    client
  );
  return Boolean(row);
}

/** All parking areas belonging to an owner. The data model allows more than one. */
async function listParkingAreas(ownerId, client = null) {
  return db.queryMany(
    `SELECT id, name, slug, lat, lng, address_line, locality, city,
            total_car_slots, total_bike_slots,
            base_car_price_paise, base_bike_price_paise,
            is_active, is_open_24_7, timezone_offset_minutes,
            rating_avg, rating_count, created_at, updated_at
       FROM parking_areas
      WHERE owner_id = $1
      ORDER BY created_at ASC`,
    [ownerId],
    client
  );
}

/** The owner's primary lot — used to bootstrap the operator dashboard. */
async function primaryParkingArea(ownerId, client = null) {
  return db.queryOne(
    `SELECT id, name FROM parking_areas
      WHERE owner_id = $1 AND is_active
      ORDER BY created_at ASC
      LIMIT 1`,
    [ownerId],
    client
  );
}

module.exports = {
  findById,
  findByPhone,
  findByPhoneWithSecret,
  createOrGet,
  setPasswordHash,
  updateProfile,
  ownsParkingArea,
  listParkingAreas,
  primaryParkingArea,
};
