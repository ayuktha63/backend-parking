'use strict';

/**
 * Pricing.
 *
 * A port of the demand-forecasting engine that already existed in the old
 * server.js — and which no client ever called, because both apps displayed a
 * hardcoded "₹30/hr" string instead.
 *
 * Four defects fixed in the port:
 *
 *   1. OCCUPANCY COUNTED EVERYTHING. The old query counted every booking row for a
 *      slot with no time filter and no status filter, so a booking for next Tuesday
 *      inflated today's price. Occupancy is now measured over the requested window.
 *
 *   2. `advance_payable_now` WAS HARDCODED TO 1 at both return sites, while
 *      `getAdvancePayableNow` — the function that computes a real 20–40% advance —
 *      was defined and never called.
 *
 *   3. THE SELF-DOCUMENTING FORMULA WAS WRONG. The response advertised
 *      `base_price * (1 + effective_occupancy_ratio * 0.8)` while the code used 0.2,
 *      making the documented maximum multiplier unreachable.
 *
 *   4. MONEY WAS RUPEE FLOATS. Everything here is integer paise.
 *
 * The server is the sole authority on price. A client never sends an amount.
 */

const { config } = require('../config');
const db = require('../db');
const money = require('../utils/money');
const time = require('../utils/time');

const P = config.pricing;

/* ── demand signals ────────────────────────────────────────────────────────── */

/**
 * Projects occupancy one hour ahead from four weighted signals.
 *
 * Deliberately transparent: every response carries the signal counts and a
 * human-readable reason, so a price rise is explainable to an operator rather than
 * being a black box.
 */
async function getDemandForecast({ parkingAreaId, vehicleType, totalSlots, occupiedSlots }) {
  const empty = {
    horizon_minutes: P.forecastHorizonMinutes,
    projected_occupancy_ratio: 0,
    projected_occupied_slots: 0,
    projected_demand_level: 'low',
    confidence: 0,
    reason: 'No capacity configured for this vehicle type',
    signals: {
      active_holds: 0,
      recent_pending_bookings: 0,
      recent_confirmed_bookings: 0,
      recent_departures: 0,
    },
  };

  if (totalSlots <= 0) return empty;

  const lookback = P.forecastLookbackMinutes;

  const row = await db.queryOne(
    `SELECT
       (SELECT COUNT(*)::int FROM slot_holds h
          JOIN parking_slots ps ON ps.id = h.parking_slot_id
         WHERE ps.parking_area_id = $1 AND ps.vehicle_type = $2
           AND h.hold_expires_at > NOW()
           AND h.consumed_at IS NULL AND h.released_at IS NULL) AS active_holds,

       (SELECT COUNT(*)::int FROM bookings b
         WHERE b.parking_id = $1 AND b.vehicle_type = $2
           AND b.status = 'PENDING_PAYMENT'
           AND b.created_at > NOW() - ($3 || ' minutes')::interval) AS pending_bookings,

       (SELECT COUNT(*)::int FROM bookings b
         WHERE b.parking_id = $1 AND b.vehicle_type = $2
           AND b.status IN ('CONFIRMED','CHECKED_IN')
           AND b.created_at > NOW() - ($3 || ' minutes')::interval) AS confirmed_bookings,

       (SELECT COUNT(*)::int FROM bookings b
         WHERE b.parking_id = $1 AND b.vehicle_type = $2
           AND b.status = 'COMPLETED'
           AND b.completed_at > NOW() - ($3 || ' minutes')::interval) AS departures`,
    [parkingAreaId, vehicleType, lookback]
  );

  const activeHolds = row?.active_holds ?? 0;
  const pending = row?.pending_bookings ?? 0;
  const confirmed = row?.confirmed_bookings ?? 0;
  const departures = row?.departures ?? 0;

  const w = P.demandSignalWeights;
  const delta =
    activeHolds * w.activeHold +
    pending * w.recentPendingBooking +
    confirmed * w.recentVerifiedBooking +
    departures * w.recentDeparture;

  const projectedOccupied = clamp(Math.round(occupiedSlots + delta), 0, totalSlots);
  const projectedRatio = clamp(projectedOccupied / totalSlots, 0, 1);
  const signalVolume = activeHolds + pending + confirmed + departures;

  return {
    horizon_minutes: P.forecastHorizonMinutes,
    projected_occupancy_ratio: round2(projectedRatio),
    projected_occupied_slots: projectedOccupied,
    projected_demand_level: demandLevel(projectedRatio),
    confidence: round2(clamp(signalVolume / Math.max(totalSlots, 1), 0.2, 1)),
    reason:
      `Last ${lookback} min — holds ${activeHolds}, pending ${pending}, ` +
      `confirmed ${confirmed}, departures ${departures}`,
    signals: {
      active_holds: activeHolds,
      recent_pending_bookings: pending,
      recent_confirmed_bookings: confirmed,
      recent_departures: departures,
    },
  };
}

/* ── occupancy ─────────────────────────────────────────────────────────────── */

/**
 * Occupancy for a specific window, not "all bookings ever".
 *
 * A slot counts as occupied only if an active booking's window actually overlaps
 * the window being priced.
 */
async function getWindowOccupancy({ parkingAreaId, vehicleType, startAt, endAt, client = null }) {
  const row = await db.queryOne(
    `SELECT
       (SELECT COUNT(*)::int FROM parking_slots ps
         WHERE ps.parking_area_id = $1 AND ps.vehicle_type = $2 AND ps.is_active) AS total_slots,

       (SELECT COUNT(DISTINCT b.parking_slot_id)::int FROM bookings b
         WHERE b.parking_id = $1 AND b.vehicle_type = $2
           AND b.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
           AND b.parking_slot_id IS NOT NULL
           AND tstzrange(b.entry_time, b.expected_exit_time, '[)')
               && tstzrange($3::timestamptz, $4::timestamptz, '[)')) AS occupied_slots,

       (SELECT COUNT(DISTINCT h.parking_slot_id)::int FROM slot_holds h
          JOIN parking_slots ps ON ps.id = h.parking_slot_id
         WHERE ps.parking_area_id = $1 AND ps.vehicle_type = $2
           AND h.hold_expires_at > NOW()
           AND h.consumed_at IS NULL AND h.released_at IS NULL) AS held_slots`,
    [parkingAreaId, vehicleType, startAt, endAt],
    client
  );

  const total = row?.total_slots ?? 0;
  const occupied = row?.occupied_slots ?? 0;
  const held = row?.held_slots ?? 0;

  return {
    total,
    occupied,
    held,
    available: Math.max(total - occupied - held, 0),
    ratio: total > 0 ? clamp(occupied / total, 0, 1) : 0,
  };
}

/* ── quote ─────────────────────────────────────────────────────────────────── */

/**
 * The single entry point for "what does this cost?".
 *
 * Used by the pricing endpoint, by booking creation and by payment-order creation,
 * so a user is never quoted one number and charged another.
 *
 * @returns a full breakdown — every line the Review screen displays comes from here.
 */
async function quote({
  parkingArea,
  vehicleType,
  startAt,
  durationMinutes,
  slotCount = 1,
  client = null,
}) {
  const vType = String(vehicleType).toLowerCase();
  const duration = Number(durationMinutes) || config.booking.defaultDurationMinutes;
  const start = time.parseInstant(startAt) || time.nowUtc();
  const end = time.addMinutes(start, duration);

  const basePaise = basePriceFor(parkingArea, vType);

  const occupancy = await getWindowOccupancy({
    parkingAreaId: parkingArea.id,
    vehicleType: vType,
    startAt: start,
    endAt: end,
    client,
  });

  const forecast = await getDemandForecast({
    parkingAreaId: parkingArea.id,
    vehicleType: vType,
    totalSlots: occupancy.total,
    occupiedSlots: occupancy.occupied,
  });

  const multiplier = computeMultiplier(occupancy.ratio, forecast.projected_occupancy_ratio);

  // Price is quoted per hour, then charged per started hour. Users understand
  // "₹48/hr for 2 hours", not a per-minute rate.
  const hourlyPaise = money.applyMultiplierToWholeRupees(basePaise, multiplier);
  const billedHours = Math.max(1, Math.ceil(duration / 60));
  const subtotalPaise = hourlyPaise * billedHours * Math.max(1, slotCount);

  const platformFeePaise = money.applyBasisPoints(subtotalPaise, P.platformFeeBps);
  const totalPaise = money.sum(subtotalPaise, platformFeePaise);

  const level = demandLevel(occupancy.ratio);

  return {
    currency: config.payments.currency,

    // Line items — the Review screen renders these directly.
    base_price_paise: basePaise,
    hourly_price_paise: hourlyPaise,
    billed_hours: billedHours,
    slot_count: Math.max(1, slotCount),
    subtotal_paise: subtotalPaise,
    platform_fee_paise: platformFeePaise,
    total_paise: totalPaise,

    // Why the price is what it is.
    multiplier: round2(multiplier),
    is_surge: multiplier > 1.02,
    demand_level: level,
    occupancy: {
      total_slots: occupancy.total,
      occupied_slots: occupancy.occupied,
      held_slots: occupancy.held,
      available_slots: occupancy.available,
      ratio: round2(occupancy.ratio),
    },
    forecast,

    // Window this quote applies to.
    starts_at: time.toIso(start),
    ends_at: time.toIso(end),
    duration_minutes: duration,

    // Advance payable at booking time. Now actually computed, rather than the
    // hardcoded 1 the old engine returned from both of its return sites.
    advance_payable_paise: advancePayable(totalPaise, level),

    pricing_formula:
      `hourly = round_to_rupee(base × clamp(1 + effective_occupancy × ${P.occupancyWeight}, ` +
      `${P.minMultiplier}, ${P.maxMultiplier})); total = hourly × billed_hours × slots + fees`,
  };
}

/**
 * Final amount at check-out.
 *
 * Replaces the operator app's `amount = seconds parked` — which billed one rupee per
 * second, so an hour read as ₹3,600 — and the server's `Math.max(server, client)`,
 * which let the client's number win for anything over about twenty seconds.
 *
 * The client no longer supplies an amount at all.
 */
function finalAmount({ booking, exitAt, parkingArea }) {
  const vType = String(booking.vehicle_type).toLowerCase();
  const entry = time.parseInstant(booking.entry_time);
  const exit = time.parseInstant(exitAt) || time.nowUtc();

  const reservedPaise = money.toPaise(booking.amount_paise);
  const parkedMinutes = time.billableMinutes(entry, exit);
  const reservedMinutes = Number(booking.duration_minutes) || config.booking.defaultDurationMinutes;

  // Within what was reserved and paid for: nothing more is owed.
  if (parkedMinutes <= reservedMinutes) {
    return {
      total_paise: reservedPaise,
      reserved_paise: reservedPaise,
      overstay_paise: 0,
      parked_minutes: parkedMinutes,
      reserved_minutes: reservedMinutes,
      overstay_minutes: 0,
      rule: 'within_reservation',
    };
  }

  // Overstay, charged per started half hour.
  const overstayMinutes = parkedMinutes - reservedMinutes;
  const halfHours = Math.ceil(overstayMinutes / 30);
  const overstayPaise = halfHours * overstayRateFor(parkingArea, vType);

  return {
    total_paise: money.sum(reservedPaise, overstayPaise),
    reserved_paise: reservedPaise,
    overstay_paise: overstayPaise,
    parked_minutes: parkedMinutes,
    reserved_minutes: reservedMinutes,
    overstay_minutes: overstayMinutes,
    overstay_half_hours: halfHours,
    rule: 'reservation_plus_overstay_per_half_hour',
  };
}

/**
 * Refund due on cancellation.
 *
 * Slabs come from config. The old implementation had two adjacent tiers both set to
 * 40%, which made the boundary between them meaningless.
 */
function refundQuote({ amountPaise, entryAt, now = time.nowUtc() }) {
  const minutesUntilEntry = time.diffMinutes(entryAt, now) ?? 0;

  const slab =
    config.refunds.slabs.find((s) => minutesUntilEntry >= s.minMinutesBefore) ||
    config.refunds.slabs[config.refunds.slabs.length - 1];

  const refundPaise = money.percentOf(amountPaise, slab.percent);

  return {
    refund_percent: slab.percent,
    refund_paise: refundPaise,
    retained_paise: Math.max(money.toPaise(amountPaise) - refundPaise, 0),
    minutes_until_entry: minutesUntilEntry,
    // Stated plainly, because the old flow told users "Booking Cancelled" and never
    // mentioned money at all.
    policy:
      slab.percent === 0
        ? 'No refund within 15 minutes of your entry time'
        : `${slab.percent}% refunded when cancelled more than ${slab.minMinutesBefore} minutes before entry`,
  };
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

function basePriceFor(parkingArea, vehicleType) {
  const configured =
    vehicleType === 'bike'
      ? parkingArea?.base_bike_price_paise
      : parkingArea?.base_car_price_paise;

  const value = Number(configured);
  if (Number.isFinite(value) && value > 0) return Math.round(value);
  return P.fallbackBasePaise[vehicleType] ?? P.fallbackBasePaise.car;
}

function overstayRateFor(parkingArea, vehicleType) {
  // Half the hourly base, floored at the configured minimum, so overstaying a bike
  // slot does not cost the same as a car.
  const base = basePriceFor(parkingArea, vehicleType);
  return Math.max(Math.round(base / 2), P.overstayHalfHourPaise);
}

/**
 * Blends current occupancy with the near-term forecast, then applies guardrails so
 * the price cannot jump between two consecutive requests.
 */
function computeMultiplier(currentRatio, forecastRatio) {
  const effective =
    (1 - P.forecastWeight) * currentRatio + P.forecastWeight * Number(forecastRatio || 0);

  const raw = 1 + effective * P.occupancyWeight;
  const bounded = clamp(raw, P.minMultiplier, P.maxMultiplier);

  // Rate-limit movement relative to what pure current occupancy would give.
  const currentOnly = 1 + currentRatio * P.occupancyWeight;
  return clamp(
    bounded,
    Math.max(P.minMultiplier, currentOnly - P.maxStepDownPerRequest),
    Math.min(P.maxMultiplier, currentOnly + P.maxStepUpPerRequest)
  );
}

function demandLevel(ratio) {
  if (ratio >= 0.8) return 'high';
  if (ratio >= 0.5) return 'medium';
  return 'low';
}

function advancePayable(totalPaise, level) {
  const ratio = P.advanceRatioByDemand?.[level] ?? P.advanceRatioByDemand?.fallback ?? 0.25;
  // Round up to a whole rupee — an advance of ₹12.37 is not a thing.
  const raw = money.toPaise(totalPaise) * ratio;
  return Math.max(money.PAISE_PER_RUPEE, Math.ceil(raw / money.PAISE_PER_RUPEE) * money.PAISE_PER_RUPEE);
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function round2(v) {
  return Number((Number(v) || 0).toFixed(2));
}

module.exports = {
  quote,
  finalAmount,
  refundQuote,
  getWindowOccupancy,
  getDemandForecast,
  // exported for tests
  _internal: { computeMultiplier, demandLevel, basePriceFor, advancePayable, overstayRateFor },
};
