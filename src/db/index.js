'use strict';

/**
 * Database access.
 *
 * Everything that touches Postgres goes through here. Two rules:
 *   1. All SQL lives in src/repositories — never in a controller or route.
 *   2. Any operation that writes more than one row uses `withTransaction`.
 *
 * `withTransaction` retries serialization failures and deadlocks automatically,
 * which the previous implementation did not do at all.
 */

const { Pool, types } = require('pg');
const { config } = require('../config');
const { logger } = require('../utils/logger');
const { isRetryablePgError, internal, serviceUnavailable } = require('../utils/errors');

/**
 * Postgres type parsers.
 *
 * `pg` returns int8 (bigint) and numeric as STRINGS by default, because both can
 * exceed what a JavaScript number represents exactly. That default is correct in
 * general and wrong for this schema, and the wrongness is invisible until runtime:
 *
 *   every id column here is `bigserial`, so `{"id": 1}` was serialised as
 *   `{"id": "1"}` — and every Flutter model parses ids with `(json['id'] as num?)`,
 *   which yields null for a String and falls back to 0. Every parking card,
 *   booking and slot would arrive with id 0, and every tap would route to /0.
 *
 * Sequence-generated ids cannot approach 2^53, so parsing int8 as a number is
 * exact for every value this system can produce. The guard below keeps it honest:
 * anything that genuinely exceeds the safe range stays a string rather than being
 * silently rounded.
 *
 * NUMERIC is deliberately NOT converted. `parking_areas.rating_avg` and the legacy
 * `bookings.amount` are numeric, and float conversion is precisely the money bug
 * this codebase exists to remove — services convert those explicitly where they
 * are read.
 */
const PG_INT8_OID = 20;

types.setTypeParser(PG_INT8_OID, (value) => {
  if (value === null) return null;
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value;
});

let pool = null;

function getPool() {
  if (pool) return pool;

  if (!config.db.url) {
    throw internal(
      'DATABASE_URL is not configured. Copy .env.example to .env and set it.'
    );
  }

  pool = new Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    idleTimeoutMillis: config.db.idleTimeoutMs,
    connectionTimeoutMillis: config.db.connectionTimeoutMs,
    // Prevents one pathological query from pinning a connection forever.
    statement_timeout: config.db.statementTimeoutMs,
    application_name: 'parqx-api',
  });

  pool.on('error', (err) => {
    // An idle client erroring is not fatal; pg will replace it.
    logger.error({ err }, 'Idle database client error');
  });

  return pool;
}

/**
 * Runs a single statement. Prefer repository functions over calling this directly.
 * @param {string} text
 * @param {any[]} [params]
 * @param {import('pg').PoolClient} [client] use an existing transaction client
 */
async function query(text, params = [], client = null) {
  const runner = client || getPool();
  const startedAt = process.hrtime.bigint();
  try {
    const result = await runner.query(text, params);
    logSlowQuery(text, startedAt);
    return result;
  } catch (err) {
    logger.error(
      { err, sql: firstLine(text), code: err.code, constraint: err.constraint },
      'Query failed'
    );
    throw err;
  }
}

/** Convenience: first row or null. */
async function queryOne(text, params = [], client = null) {
  const result = await query(text, params, client);
  return result.rows[0] || null;
}

/** Convenience: rows array. */
async function queryMany(text, params = [], client = null) {
  const result = await query(text, params, client);
  return result.rows;
}

/**
 * Runs `fn` inside a transaction, retrying on transient serialization conflicts.
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {object} [opts]
 * @param {'read committed'|'repeatable read'|'serializable'} [opts.isolation]
 * @param {number} [opts.retries]
 * @template T
 * @returns {Promise<T>}
 */
async function withTransaction(fn, { isolation, retries = 2 } = {}) {
  let attempt = 0;

  for (;;) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      if (isolation) {
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}`);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ err: rollbackErr }, 'Rollback failed');
      }

      if (isRetryablePgError(err) && attempt < retries) {
        attempt += 1;
        const backoffMs = 25 * 2 ** attempt + Math.floor(Math.random() * 25);
        logger.warn({ attempt, code: err.code, backoffMs }, 'Retrying transaction');
        await sleep(backoffMs);
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Runs `fn` inside a transaction, unless an existing transaction client was passed
 * in — in which case it joins that one.
 *
 * This lets a repository function be both independently callable and composable
 * into a larger service transaction, without nested BEGINs (which Postgres does not
 * support) and without every caller having to care.
 *
 * @param {import('pg').PoolClient|null} client
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @template T
 */
async function withTransactionOrClient(client, fn) {
  if (client) return fn(client);
  return withTransaction(fn);
}

/**
 * Takes a transaction-scoped advisory lock.
 *
 * This is how double-booking is prevented. The previous implementation ran its
 * overlap check *before* BEGIN and then relied on `SELECT ... FOR UPDATE`, which
 * locks nothing when a slot has no existing rows — so two concurrent requests for
 * a free slot could both succeed. An advisory lock keyed on the slot has no such
 * gap: it serialises on the *identity* of the slot, not on rows that happen to exist.
 *
 * The lock is released automatically when the transaction ends.
 *
 * @param {import('pg').PoolClient} client must be inside a transaction
 * @param {string} namespace e.g. 'slot'
 * @param {string|number} key
 */
async function advisoryXactLock(client, namespace, key) {
  // hashtextextended gives a stable 64-bit key from arbitrary text.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${namespace}:${key}`,
  ]);
}

/** Non-blocking variant. Returns true when the lock was acquired. */
async function tryAdvisoryXactLock(client, namespace, key) {
  const res = await client.query(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
    [`${namespace}:${key}`]
  );
  return res.rows[0]?.locked === true;
}

/**
 * Session-level advisory lock used for job leader election, so that the hold and
 * booking sweepers run once across a multi-instance deployment instead of once
 * per process.
 */
async function tryAdvisorySessionLock(key) {
  const client = await getPool().connect();
  try {
    const res = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [key]
    );
    if (res.rows[0]?.locked === true) return client; // caller must release
    client.release();
    return null;
  } catch (err) {
    client.release();
    throw err;
  }
}

/** Verifies connectivity. Used by /health and at boot. */
async function healthCheck() {
  try {
    const res = await query('SELECT 1 AS ok, NOW() AS now');
    return { ok: true, now: res.rows[0].now };
  } catch (err) {
    logger.error({ err }, 'Database health check failed');
    throw serviceUnavailable('Database is unreachable', err);
  }
}

async function close() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

function firstLine(sql) {
  return String(sql).trim().split('\n')[0].slice(0, 160);
}

function logSlowQuery(text, startedAt) {
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (ms > 500) logger.warn({ ms: Math.round(ms), sql: firstLine(text) }, 'Slow query');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  getPool,
  query,
  queryOne,
  queryMany,
  withTransaction,
  withTransactionOrClient,
  advisoryXactLock,
  tryAdvisoryXactLock,
  tryAdvisorySessionLock,
  healthCheck,
  close,
};
