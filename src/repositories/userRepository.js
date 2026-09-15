'use strict';

/**
 * Users (customers).
 *
 * Every SQL statement touching `users` and `vehicles` lives here. Controllers and
 * services never write SQL — that separation is what the previous 1,672-line
 * server.js lacked entirely.
 */

const db = require('../db');

const USER_COLUMNS = `
  id, phone, name, is_active, phone_verified, last_login_at, onboarded_at,
  created_at, updated_at
`;

async function findById(id, client = null) {
  return db.queryOne(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id], client);
}

async function findByPhone(phone, client = null) {
  return db.queryOne(`SELECT ${USER_COLUMNS} FROM users WHERE phone = $1`, [phone], client);
}

/**
 * Creates a user, or returns the existing one for that phone.
 *
 * Atomic via ON CONFLICT, so two simultaneous first-time logins cannot race into
 * duplicate accounts.
 */
async function createOrGet({ phone, name }, client = null) {
  const row = await db.queryOne(
    `INSERT INTO users (phone, name, phone_verified, created_at, updated_at)
     VALUES ($1, $2, true, NOW(), NOW())
     ON CONFLICT (phone) DO UPDATE
       SET phone_verified = true,
           -- Only fill in a name if the account does not already have a real one.
           name = CASE
                    WHEN users.name IS NULL OR users.name = '' OR users.name = 'User'
                    THEN COALESCE(EXCLUDED.name, users.name)
                    ELSE users.name
                  END,
           updated_at = NOW()
     RETURNING ${USER_COLUMNS}, (xmax = 0) AS was_created`,
    [phone, name || 'User'],
    client
  );
  return row;
}

async function updateProfile(id, { name }, client = null) {
  return db.queryOne(
    `UPDATE users
        SET name = COALESCE($2, name),
            onboarded_at = COALESCE(onboarded_at, NOW()),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${USER_COLUMNS}`,
    [id, name ?? null],
    client
  );
}

async function markLoggedIn(id, client = null) {
  await db.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [id], client);
}

/* ── vehicles ──────────────────────────────────────────────────────────────── */

const VEHICLE_COLUMNS = `
  id, user_id, vehicle_type, number_plate, label, is_default, created_at, updated_at
`;

async function listVehicles(userId, client = null) {
  return db.queryMany(
    `SELECT ${VEHICLE_COLUMNS} FROM vehicles
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at ASC`,
    [userId],
    client
  );
}

async function findVehicle(userId, vehicleId, client = null) {
  return db.queryOne(
    `SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE user_id = $1 AND id = $2`,
    [userId, vehicleId],
    client
  );
}

/**
 * Adds a vehicle, or updates the existing one with the same plate.
 * The unique index is on (user_id, normalised plate), so re-adding a plate is
 * idempotent rather than an error the user has to interpret.
 */
async function addVehicle(userId, { vehicleType, numberPlate, label, isDefault }, client = null) {
  return db.withTransactionOrClient(client, async (tx) => {
    if (isDefault) {
      await db.query(
        `UPDATE vehicles SET is_default = false, updated_at = NOW()
          WHERE user_id = $1 AND vehicle_type = $2 AND is_default`,
        [userId, vehicleType],
        tx
      );
    }

    // First vehicle of a type becomes the default automatically.
    const existingCount = await db.queryOne(
      `SELECT COUNT(*)::int AS c FROM vehicles WHERE user_id = $1 AND vehicle_type = $2`,
      [userId, vehicleType],
      tx
    );
    const shouldDefault = isDefault || existingCount.c === 0;

    return db.queryOne(
      `INSERT INTO vehicles (user_id, vehicle_type, number_plate, label, is_default)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, upper(replace(number_plate, ' ', '')))
       DO UPDATE SET vehicle_type = EXCLUDED.vehicle_type,
                     label        = COALESCE(EXCLUDED.label, vehicles.label),
                     is_default   = vehicles.is_default OR EXCLUDED.is_default,
                     updated_at   = NOW()
       RETURNING ${VEHICLE_COLUMNS}`,
      [userId, vehicleType, numberPlate, label ?? null, shouldDefault],
      tx
    );
  });
}

async function setDefaultVehicle(userId, vehicleId, client = null) {
  return db.withTransactionOrClient(client, async (tx) => {
    const vehicle = await findVehicle(userId, vehicleId, tx);
    if (!vehicle) return null;

    await db.query(
      `UPDATE vehicles SET is_default = false, updated_at = NOW()
        WHERE user_id = $1 AND vehicle_type = $2`,
      [userId, vehicle.vehicle_type],
      tx
    );
    return db.queryOne(
      `UPDATE vehicles SET is_default = true, updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING ${VEHICLE_COLUMNS}`,
      [vehicleId, userId],
      tx
    );
  });
}

async function deleteVehicle(userId, vehicleId, client = null) {
  const row = await db.queryOne(
    `DELETE FROM vehicles WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, vehicleId],
    client
  );
  return Boolean(row);
}

module.exports = {
  findById,
  findByPhone,
  createOrGet,
  updateProfile,
  markLoggedIn,
  listVehicles,
  findVehicle,
  addVehicle,
  setDefaultVehicle,
  deleteVehicle,
};
