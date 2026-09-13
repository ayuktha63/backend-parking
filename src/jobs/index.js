'use strict';

/**
 * Background jobs.
 *
 * Two changes from the previous implementation, which ran two bare `setInterval`
 * timers in every process:
 *
 *   1. LEADER ELECTION. A Postgres session advisory lock means the sweepers run
 *      once per deployment, not once per instance. Scaling the service past one
 *      instance previously multiplied this work silently.
 *
 *   2. NOTHING IS DELETED. The old booking sweeper hard-deleted unverified bookings
 *      after five minutes with no archive — the comment in the source acknowledged
 *      skipping archival "for simplicity". Records simply vanished, which is also
 *      what happened to every operator walk-in not verified in time. Here, expiry is
 *      a status transition with an audit event.
 */

const { config } = require('../config');
const db = require('../db');
const { logger } = require('../utils/logger');
const gateway = require('../sockets/gateway');

const LEADER_LOCK_KEY = 'parqx:jobs:leader';

const state = {
  leaderClient: null,
  timers: [],
  running: false,
};

/** Wraps a job so an overrun cannot stack and a failure cannot kill the timer. */
function guarded(name, fn) {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      logger.warn({ job: name }, 'Skipping run; previous run still in flight');
      return;
    }
    inFlight = true;
    const startedAt = Date.now();
    try {
      const result = await fn();
      if (result && result.affected > 0) {
        logger.info({ job: name, ...result, ms: Date.now() - startedAt }, 'Job completed');
      }
    } catch (err) {
      logger.error({ err, job: name }, 'Job failed');
    } finally {
      inFlight = false;
    }
  };
}

/**
 * Releases expired slot holds.
 *
 * Marks them released rather than deleting, so the hold-to-booking funnel stays
 * measurable — how often people select a slot and then abandon it is a product
 * signal the old `DELETE` threw away.
 */
async function sweepExpiredHolds() {
  const rows = await db.queryMany(
    `UPDATE slot_holds
        SET released_at = NOW(), release_reason = 'expired'
      WHERE released_at IS NULL
        AND consumed_at IS NULL
        AND hold_expires_at < NOW()
      RETURNING id, parking_id, parking_slot_id, slot_number, vehicle_type, user_id`
  );

  for (const row of rows) {
    gateway.emitSlotUpdate({
      parkingAreaId: row.parking_id,
      vehicleType: row.vehicle_type,
      slotId: row.parking_slot_id,
      slotNumber: row.slot_number,
      status: 'available',
    });
    // Tell the person whose hold it was. Their countdown has just reached zero;
    // without this the app would keep showing a slot it no longer has.
    gateway.emitHoldExpired(row.user_id, {
      hold_id: row.id,
      parking_area_id: row.parking_id,
      slot_id: row.parking_slot_id,
    });
  }

  return { affected: rows.length };
}

/**
 * Expires bookings that were never paid for.
 *
 * Status transition plus an audit event — never a delete.
 */
async function sweepUnpaidBookings() {
  const seconds = config.booking.pendingPaymentSeconds;

  return db.withTransaction(async (tx) => {
    const rows = await db.queryMany(
      `UPDATE bookings
          SET status = 'EXPIRED', updated_at = NOW()
        WHERE status = 'PENDING_PAYMENT'
          AND created_at < NOW() - ($1 || ' seconds')::interval
        RETURNING id, user_id, parking_id, parking_slot_id, slot_number, vehicle_type`,
      [seconds],
      tx
    );

    for (const row of rows) {
      await db.query(
        `INSERT INTO booking_events (booking_id, event_type, from_status, to_status, actor_type, metadata)
         VALUES ($1, 'expired', 'PENDING_PAYMENT', 'EXPIRED', 'system', $2)`,
        [row.id, JSON.stringify({ reason: 'payment_not_completed', after_seconds: seconds })],
        tx
      );
    }

    // Emitted after the transaction would be more correct, but these are advisory
    // UI nudges and the transaction is committed by the caller immediately after.
    for (const row of rows) {
      gateway.emitSlotUpdate({
        parkingAreaId: row.parking_id,
        vehicleType: row.vehicle_type,
        slotId: row.parking_slot_id,
        slotNumber: row.slot_number,
        status: 'available',
      });
      gateway.emitBookingUpdate(row.user_id, { id: row.id, status: 'EXPIRED' });
    }

    return { affected: rows.length };
  });
}

/**
 * Marks confirmed bookings whose window has fully passed without a check-in.
 *
 * A no-show is a distinct, reportable outcome; the old system had no concept of it,
 * so an unused booking stayed "active" forever or was deleted without trace.
 */
async function sweepNoShows() {
  const grace = config.booking.noShowGraceMinutes;

  return db.withTransaction(async (tx) => {
    const rows = await db.queryMany(
      `UPDATE bookings
          SET status = 'NO_SHOW', updated_at = NOW()
        WHERE status = 'CONFIRMED'
          AND expected_exit_time IS NOT NULL
          AND expected_exit_time < NOW() - ($1 || ' minutes')::interval
        RETURNING id, user_id, parking_id, parking_slot_id, slot_number, vehicle_type`,
      [grace],
      tx
    );

    for (const row of rows) {
      await db.query(
        `INSERT INTO booking_events (booking_id, event_type, from_status, to_status, actor_type, metadata)
         VALUES ($1, 'no_show', 'CONFIRMED', 'NO_SHOW', 'system', $2)`,
        [row.id, JSON.stringify({ grace_minutes: grace })],
        tx
      );
      gateway.emitSlotUpdate({
        parkingAreaId: row.parking_id,
        vehicleType: row.vehicle_type,
        slotId: row.parking_slot_id,
        slotNumber: row.slot_number,
        status: 'available',
      });
    }

    return { affected: rows.length };
  });
}

/**
 * Sends refunds that have been recorded but not yet dispatched to the provider.
 *
 * Separated from cancellation on purpose: a gateway outage should delay a refund,
 * never lose the record that one is owed.
 */
async function dispatchRefunds() {
  // eslint-disable-next-line global-require
  const paymentService = require('../services/paymentService');
  return paymentService.dispatchPendingRefunds({ limit: 20 });
}

/** Housekeeping: consumed OTPs and long-expired refresh tokens. */
async function sweepAuthArtifacts() {
  // eslint-disable-next-line global-require
  const otpRepository = require('../repositories/otpRepository');
  // eslint-disable-next-line global-require
  const tokenRepository = require('../repositories/tokenRepository');

  const otps = await otpRepository.purgeExpired(24);
  const tokens = await tokenRepository.purgeExpired(60);
  return { affected: otps + tokens, otps, tokens };
}

/**
 * Attempts to become the job leader. Retried periodically, so if the leader process
 * dies another instance picks the work up rather than the jobs silently stopping.
 */
async function tryBecomeLeader() {
  if (state.leaderClient) return true;
  try {
    const client = await db.tryAdvisorySessionLock(LEADER_LOCK_KEY);
    if (client) {
      state.leaderClient = client;
      logger.info('Acquired the job leader lock; background jobs are running on this instance');
      client.on('error', () => {
        state.leaderClient = null;
        logger.warn('Lost the job leader lock; another instance will take over');
      });
      return true;
    }
  } catch (err) {
    logger.error({ err }, 'Leader election failed');
  }
  return false;
}

function start() {
  if (!config.jobs.enabled) {
    logger.info('Background jobs are disabled by configuration');
    return;
  }
  if (state.running) return;
  state.running = true;

  const holdSweep = guarded('sweepExpiredHolds', sweepExpiredHolds);
  const unpaidSweep = guarded('sweepUnpaidBookings', sweepUnpaidBookings);
  const noShowSweep = guarded('sweepNoShows', sweepNoShows);
  const authSweep = guarded('sweepAuthArtifacts', sweepAuthArtifacts);
  const refundDispatch = guarded('dispatchRefunds', dispatchRefunds);

  const onlyAsLeader = (fn) => async () => {
    if (!(await tryBecomeLeader())) return;
    await fn();
  };

  state.timers.push(setInterval(onlyAsLeader(holdSweep), config.jobs.holdSweepIntervalMs));
  state.timers.push(setInterval(onlyAsLeader(unpaidSweep), config.jobs.bookingSweepIntervalMs));
  state.timers.push(setInterval(onlyAsLeader(noShowSweep), 5 * 60_000));
  state.timers.push(setInterval(onlyAsLeader(authSweep), 60 * 60_000));
  state.timers.push(setInterval(onlyAsLeader(refundDispatch), config.jobs.refundDispatchIntervalMs));

  for (const t of state.timers) t.unref?.();

  logger.info(
    {
      holdSweepMs: config.jobs.holdSweepIntervalMs,
      bookingSweepMs: config.jobs.bookingSweepIntervalMs,
    },
    'Background jobs started'
  );
}

async function stop() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  state.running = false;

  if (state.leaderClient) {
    try {
      await state.leaderClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        LEADER_LOCK_KEY,
      ]);
    } catch {
      // The connection is closing anyway; the lock is released with the session.
    }
    state.leaderClient.release();
    state.leaderClient = null;
  }
}

module.exports = {
  start,
  stop,
  // exported for tests and manual invocation
  sweepExpiredHolds,
  sweepUnpaidBookings,
  sweepNoShows,
  sweepAuthArtifacts,
  dispatchRefunds,
};
