'use strict';

/**
 * Operator operations.
 *
 * THE AUTHORISATION RULE, applied without exception: every function here begins by
 * resolving which parking areas the *authenticated* operator owns, and every query
 * is then scoped to that set. A `parking_area_id`, `booking_id` or `slot_id` in a
 * request is treated as a claim to be checked, never as a fact.
 *
 * This is the structural fix for the previous system, where
 * `POST /api/owner/parking_areas` located a lot by `WHERE name = $1` — so any
 * anonymous caller who knew a lot's name could rewrite its capacity, and doing so
 * ran `DELETE FROM bookings WHERE parking_id = $1`.
 *
 * THE DISCLOSURE RULE: an operator reads other people's bookings. They get what the
 * job needs — who is arriving, in what car, for which slot — and no more. Contact
 * details are masked in lists and revealed only on the single booking they are
 * actively handling. See `maskPhone` and its two call sites.
 */

const { config } = require('../config');
const db = require('../db');
const bookingRepository = require('../repositories/bookingRepository');
const operatorRepository = require('../repositories/operatorRepository');
const ownerRepository = require('../repositories/ownerRepository');
const parkingRepository = require('../repositories/parkingRepository');
const slotRepository = require('../repositories/slotRepository');
const bookingService = require('./bookingService');
const pricingService = require('./pricingService');
const gateway = require('../sockets/gateway');
const time = require('../utils/time');
const money = require('../utils/money');
const { logger } = require('../utils/logger');
const { notFound, conflict, badRequest } = require('../utils/errors');

/* ── authorisation ─────────────────────────────────────────────────────────── */

/**
 * The lots this operator owns. Every read and write is scoped to the result.
 *
 * An operator with no lots is a real state — a freshly registered account — and
 * returns an empty list rather than an error, so the app can show onboarding
 * instead of a failure.
 */
async function ownedParkingAreas(ownerId, client = null) {
  return ownerRepository.listParkingAreas(ownerId, client);
}

async function ownedParkingAreaIds(ownerId, client = null) {
  const areas = await ownedParkingAreas(ownerId, client);
  return areas.map((a) => Number(a.id));
}

/**
 * Resolves the lot a request is about.
 *
 * With no id, the operator's first lot. With an id, the lot — but only if they own
 * it. A lot they do not own is reported as NOT FOUND rather than FORBIDDEN: telling
 * someone "that exists but is not yours" confirms the existence of a record they
 * have no business knowing about.
 */
async function resolveParkingArea({ ownerId, parkingAreaId = null, client = null }) {
  const areas = await ownedParkingAreas(ownerId, client);

  if (areas.length === 0) {
    throw notFound(
      'No parking area is linked to your account yet. Contact PARQX support to get set up.',
      'NO_PARKING_AREA'
    );
  }

  if (parkingAreaId === null || parkingAreaId === undefined) {
    return areas[0];
  }

  const match = areas.find((a) => Number(a.id) === Number(parkingAreaId));
  if (!match) {
    throw notFound('That parking area could not be found', 'PARKING_NOT_FOUND');
  }
  return match;
}

/* ── disclosure ────────────────────────────────────────────────────────────── */

/**
 * Masks a phone number for list views.
 *
 * The operator scanning an arrivals board does not need fifty customers' phone
 * numbers on screen; they need one, for the person in front of them, and the
 * verification view gives them that. Masking the rest means a screenshot of the
 * board is not a contact-list leak.
 */
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `••••••${digits.slice(-4)}`;
}

/** First name only, for the board. The full name appears on verification. */
function shortName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

/**
 * A booking as the arrivals board shows it.
 *
 * `arrival_state` is computed server-side because the operator app and the
 * dashboard must group identically, and a rule written twice diverges.
 */
function serializeArrival(row, { now = time.nowUtc(), full = false } = {}) {
  if (!row) return null;

  const entry = time.parseInstant(row.entry_time);
  const minutesUntil = entry ? time.diffMinutes(entry, now) : null;

  return {
    id: row.id,
    code: row.booking_code,
    status: row.status,
    status_label: statusLabel(row.status),
    arrival_state: arrivalState({ status: row.status, minutesUntil, row }),

    customer: {
      // Full name only on the booking the operator is actively handling.
      name: full ? (row.customer_name ?? null) : shortName(row.customer_name),
      phone: full ? (row.phone || null) : maskPhone(row.phone),
      phone_is_masked: !full,
    },

    vehicle: {
      type: row.vehicle_type,
      number_plate: row.number_plate || null,
    },

    slot: row.slot_id
      ? {
          id: row.slot_id,
          code: row.slot_code,
          row_label: row.slot_row ?? null,
          position: row.slot_position ?? null,
          slot_class: row.slot_class ?? 'standard',
        }
      : null,

    window: {
      entry_time: time.toIso(entry),
      expected_exit_time: time.toIso(row.expected_exit_time),
      duration_minutes: row.duration_minutes,
      minutes_until_entry: minutesUntil,
    },

    amount: {
      reserved_paise: row.amount_paise ?? 0,
      reserved_display: money.formatPaise(row.amount_paise ?? 0),
      final_paise: row.final_amount_paise ?? null,
      final_display:
        row.final_amount_paise === null || row.final_amount_paise === undefined
          ? null
          : money.formatPaise(row.final_amount_paise),
    },

    payment: {
      status: row.payment_status ?? null,
      is_paid: row.payment_status === 'PAID',
    },

    // What this operator may do with this booking, decided here so a button is
    // never offered for something the server would refuse.
    actions: {
      can_check_in: canOperatorCheckIn({ status: row.status, entry, now }),
      can_check_out: row.status === 'CHECKED_IN',
      can_mark_no_show: canMarkNoShow({ status: row.status, entry, now }),
    },

    checked_in_at: row.checked_in_at ? time.toIso(row.checked_in_at) : null,
    parking_name: row.parking_name ?? null,
  };
}

/**
 * Grouping for the arrivals board.
 *
 * Deliberately coarse: five buckets an operator can scan, not a precise countdown
 * they have to read.
 */
function arrivalState({ status, minutesUntil, row }) {
  if (status === 'CHECKED_IN') {
    const exit = time.parseInstant(row?.expected_exit_time);
    if (exit && time.isBefore(exit, time.nowUtc())) return 'overstaying';
    return 'parked';
  }
  if (status === 'COMPLETED') return 'departed';
  if (status === 'CANCELLED' || status === 'EXPIRED') return 'cancelled';
  if (status === 'NO_SHOW') return 'no_show';
  if (status === 'PENDING_PAYMENT') return 'unpaid';

  if (minutesUntil === null) return 'upcoming';
  // Late but the window is still open — the operator should expect them.
  if (minutesUntil < -config.booking.checkInLateMinutes) return 'overdue';
  if (minutesUntil <= 0) return 'arriving_now';
  if (minutesUntil <= config.booking.checkInEarlyMinutes) return 'arriving_soon';
  return 'upcoming';
}

/**
 * The operator's check-in window is wider than the customer's self-service one.
 *
 * A driver who is twenty minutes late is standing at the barrier with a paid
 * booking; refusing them because a timer expired would be absurd. The operator's
 * override is recorded as such in the audit trail.
 */
function canOperatorCheckIn({ status, entry, now = time.nowUtc() }) {
  if (status !== 'CONFIRMED') return false;
  if (!entry) return false;
  const minutes = time.diffMinutes(entry, now);
  if (minutes === null) return false;
  return minutes <= config.booking.checkInEarlyMinutes;
}

function canMarkNoShow({ status, entry, now = time.nowUtc() }) {
  if (status !== 'CONFIRMED' || !entry) return false;
  const minutes = time.diffMinutes(entry, now);
  return minutes !== null && minutes < -config.booking.checkInLateMinutes;
}

function statusLabel(status) {
  switch (status) {
    case 'PENDING_PAYMENT': return 'Awaiting payment';
    case 'CONFIRMED':       return 'Confirmed';
    case 'CHECKED_IN':      return 'Checked in';
    case 'COMPLETED':       return 'Completed';
    case 'CANCELLED':       return 'Cancelled';
    case 'EXPIRED':         return 'Expired';
    case 'NO_SHOW':         return 'No-show';
    default:                return status || 'Unknown';
  }
}

/* ── dashboard ─────────────────────────────────────────────────────────────── */

/**
 * "What is happening at my facility right now?" in one round trip.
 *
 * Every number is an aggregate computed by Postgres. Nothing here fetches a list in
 * order to count it, which is what keeps the dashboard the same speed on day one
 * and in year three.
 */
async function getDashboard({ ownerId, parkingAreaId = null }) {
  const area = await resolveParkingArea({ ownerId, parkingAreaId });

  const [summary, upcoming, overdue] = await Promise.all([
    operatorRepository.dashboardSummary({
      parkingAreaId: area.id,
      arrivalWindowMinutes: config.booking.checkInEarlyMinutes,
    }),
    operatorRepository.arrivals({
      parkingAreaId: area.id,
      fromTime: time.addMinutes(time.nowUtc(), -config.booking.checkInLateMinutes),
      toTime: time.addMinutes(time.nowUtc(), 120),
      statuses: ['CONFIRMED'],
      limit: 8,
    }),
    operatorRepository.overdueArrivals({
      parkingAreaId: area.id,
      graceMinutes: config.booking.checkInLateMinutes,
      limit: 5,
    }),
  ]);

  const total = summary?.slots_total ?? 0;
  const occupied = summary?.occupied ?? 0;
  const reservedNow = summary?.reserved_now ?? 0;
  const held = summary?.held ?? 0;
  const available = Math.max(total - occupied - reservedNow - held, 0);

  return {
    parking_area: {
      id: area.id,
      name: area.name,
      is_active: area.is_active !== false,
    },

    // The headline block.
    occupancy: {
      total_slots: total,
      occupied,
      reserved_now: reservedNow,
      held,
      available,
      out_of_service: summary?.slots_out_of_service ?? 0,
      // Rounded here, once, so the two apps and the dashboard cannot disagree by
      // a percentage point.
      occupancy_percent: total === 0 ? 0 : Math.round(((occupied + reservedNow) / total) * 100),
      by_vehicle: {
        car: { total_slots: summary?.slots_car ?? 0 },
        bike: { total_slots: summary?.slots_bike ?? 0 },
      },
    },

    // Things that need a human. Empty arrays mean "all clear", which the UI says
    // in words rather than rendering an empty box.
    attention: {
      arriving_now: summary?.arriving_now ?? 0,
      arriving_soon: summary?.arriving_soon ?? 0,
      overstaying: summary?.overstaying ?? 0,
      overdue: overdue.length,
      held_slots: held,
    },

    today: {
      started_at: summary?.day_started_at ? time.toIso(summary.day_started_at) : null,
      bookings: summary?.today_bookings ?? 0,
      check_ins: summary?.today_check_ins ?? 0,
      completions: summary?.today_completions ?? 0,
      no_shows: summary?.today_no_shows ?? 0,
      cancellations: summary?.today_cancellations ?? 0,
      // Settled money only. A PENDING_PAYMENT booking is not takings.
      revenue_paise: Number(summary?.today_revenue_paise ?? 0),
      revenue_display: money.formatPaise(Number(summary?.today_revenue_paise ?? 0)),
    },

    next_arrivals: upcoming.map((r) => serializeArrival(r)),
    overdue_arrivals: overdue.map((r) => serializeArrival(r)),
  };
}

/* ── arrivals ──────────────────────────────────────────────────────────────── */

/**
 * The arrivals board, already grouped.
 *
 * Grouping server-side means the operator app renders sections rather than deciding
 * what "arriving soon" means — and the dashboard's counts use the same rule.
 */
async function getArrivals({ ownerId, parkingAreaId = null, hoursAhead = 12 }) {
  const area = await resolveParkingArea({ ownerId, parkingAreaId });
  const now = time.nowUtc();

  const rows = await operatorRepository.arrivals({
    parkingAreaId: area.id,
    // Reaches back far enough to include someone who is late but still expected.
    fromTime: time.addMinutes(now, -(config.booking.checkInLateMinutes + 120)),
    toTime: time.addMinutes(now, hoursAhead * 60),
    statuses: ['CONFIRMED', 'CHECKED_IN', 'PENDING_PAYMENT'],
    limit: 200,
  });

  const groups = {
    arriving_now: [],
    arriving_soon: [],
    upcoming: [],
    parked: [],
    needs_attention: [],
  };

  for (const row of rows) {
    const arrival = serializeArrival(row, { now });
    switch (arrival.arrival_state) {
      case 'arriving_now':
        groups.arriving_now.push(arrival); break;
      case 'arriving_soon':
        groups.arriving_soon.push(arrival); break;
      case 'parked':
        groups.parked.push(arrival); break;
      case 'overstaying':
      case 'overdue':
      case 'unpaid':
        groups.needs_attention.push(arrival); break;
      default:
        groups.upcoming.push(arrival);
    }
  }

  return {
    parking_area: { id: area.id, name: area.name },
    generated_at: time.toIso(now),
    groups,
    total: rows.length,
  };
}

/* ── booking lookup ────────────────────────────────────────────────────────── */

/**
 * Finds a booking by the code the driver reads out.
 *
 * A code for a lot this operator does not own returns NOT FOUND — the same answer
 * as a code that does not exist. Without that, an operator could enumerate the
 * platform's bookings by guessing codes and reading which ones came back "forbidden".
 */
async function lookupBooking({ ownerId, code }) {
  const areaIds = await ownedParkingAreaIds(ownerId);
  if (areaIds.length === 0) {
    throw notFound('No parking area is linked to your account yet.', 'NO_PARKING_AREA');
  }

  const cleaned = normaliseCode(code);
  if (!cleaned) {
    throw badRequest('Enter a booking code', undefined, 'CODE_REQUIRED');
  }

  const row = await operatorRepository.findByCodeForOwner({
    code: cleaned,
    parkingAreaIds: areaIds,
  });

  if (!row) {
    // Logged so a burst of failed lookups is visible, without recording the code
    // itself — a near-miss code is still somebody's credential.
    logger.info({ ownerId, codeLength: cleaned.length }, 'Operator booking lookup found nothing');
    throw notFound(
      'No booking with that code at your parking area. Check the code and try again.',
      'BOOKING_NOT_FOUND'
    );
  }

  return { booking: serializeArrival(row, { full: true }), verification: verificationFor(row) };
}

/** Fallback lookup for a driver who has lost their code. */
async function lookupByPlate({ ownerId, plate }) {
  const areaIds = await ownedParkingAreaIds(ownerId);
  if (areaIds.length === 0) {
    throw notFound('No parking area is linked to your account yet.', 'NO_PARKING_AREA');
  }

  const rows = await operatorRepository.findByPlateForOwner({ plate, parkingAreaIds: areaIds });

  return {
    matches: rows.map((r) => serializeArrival(r, { full: true })),
    count: rows.length,
  };
}

/**
 * Whether this booking admits its holder, and why not when it does not.
 *
 * Returned alongside the booking so the verification screen can be unambiguous
 * rather than making the operator infer admissibility from a status label.
 */
function verificationFor(row) {
  const now = time.nowUtc();
  const entry = time.parseInstant(row.entry_time);
  const minutesUntil = entry ? time.diffMinutes(entry, now) : null;

  if (row.status === 'CHECKED_IN') {
    return {
      admit: false,
      outcome: 'already_checked_in',
      headline: 'Already checked in',
      detail: row.checked_in_at
        ? `Checked in at ${time.toIso(row.checked_in_at)}`
        : 'This booking is already checked in.',
    };
  }

  if (row.status === 'COMPLETED') {
    return {
      admit: false,
      outcome: 'completed',
      headline: 'Already completed',
      detail: 'This parking session has ended.',
    };
  }

  if (row.status === 'CANCELLED' || row.status === 'EXPIRED') {
    return {
      admit: false,
      outcome: 'cancelled',
      headline: 'Cancelled',
      detail: row.cancellation_reason
        ? `Cancelled: ${row.cancellation_reason}`
        : 'This booking was cancelled and cannot be checked in.',
    };
  }

  if (row.status === 'NO_SHOW') {
    return {
      admit: false,
      outcome: 'no_show',
      headline: 'Marked as no-show',
      detail: 'This booking was closed after the arrival window passed.',
    };
  }

  if (row.status === 'PENDING_PAYMENT') {
    return {
      admit: false,
      outcome: 'unpaid',
      headline: 'Payment not completed',
      detail: 'This booking was never paid for. Ask the customer to complete payment in the app.',
    };
  }

  if (row.payment_status !== 'PAID') {
    // Confirmed but with no settled payment: a genuine inconsistency worth
    // surfacing rather than admitting the car and sorting it out later.
    return {
      admit: false,
      outcome: 'payment_unconfirmed',
      headline: 'Payment not confirmed',
      detail: 'We have no confirmed payment for this booking. Contact PARQX support.',
    };
  }

  if (minutesUntil !== null && minutesUntil > config.booking.checkInEarlyMinutes) {
    return {
      admit: false,
      outcome: 'too_early',
      headline: 'Too early',
      detail: `This booking starts in ${minutesUntil} minutes. Check-in opens ` +
        `${config.booking.checkInEarlyMinutes} minutes before.`,
    };
  }

  const late = minutesUntil !== null && minutesUntil < -config.booking.checkInLateMinutes;

  return {
    admit: true,
    outcome: late ? 'admit_late' : 'admit',
    headline: 'Booking verified',
    detail: late
      ? `Arriving ${Math.abs(minutesUntil)} minutes late — checking in is recorded as an override.`
      : 'Paid and valid for this time.',
    is_late: late,
  };
}

function normaliseCode(raw) {
  // Tolerant of how a code is actually typed: any case, spaces anywhere, and a
  // missing "PQX-" prefix, because operators drop it.
  const compact = String(raw || '').toUpperCase().replace(/[\s-]/g, '');
  if (!compact) return null;
  const body = compact.startsWith('PQX') ? compact.slice(3) : compact;
  if (!/^[A-Z0-9]{4,12}$/.test(body)) return null;
  return `PQX-${body}`;
}

/* ── check-in / check-out ──────────────────────────────────────────────────── */

/**
 * Operator check-in.
 *
 * Delegates to `bookingService.checkIn`, which owns the transition, the audit event
 * and the socket emissions. This function's job is authorisation and nothing else —
 * there is deliberately no second check-in implementation on the operator side.
 */
async function checkInBooking({ ownerId, bookingId }) {
  const row = await assertOwnsBooking({ ownerId, bookingId });

  // The operator's window is wider than the customer's self-service one: someone
  // twenty minutes late is standing at the barrier with a paid booking, and
  // refusing them because a timer expired would be absurd.
  //
  // Whether this counts as an override is decided HERE, from the booking's own
  // entry time — never taken from the request. A `force` flag a client could set
  // would be a documented way to bypass the timing policy entirely.
  const entry = time.parseInstant(row.entry_time);
  const minutesUntil = entry ? time.diffMinutes(entry, time.nowUtc()) : null;

  if (minutesUntil !== null && minutesUntil > config.booking.checkInEarlyMinutes) {
    throw conflict(
      `This booking starts in ${minutesUntil} minutes. Check-in opens ` +
        `${config.booking.checkInEarlyMinutes} minutes before the entry time.`,
      'OUTSIDE_CHECK_IN_WINDOW',
      { minutes_until_entry: minutesUntil }
    );
  }

  // Late, but within the operator's discretion. Recorded as `forced: true` in the
  // audit trail, which is what makes the discretion accountable.
  const isLateOverride =
    minutesUntil !== null && minutesUntil < -config.booking.checkInLateMinutes;

  const result = await bookingService.checkIn({
    bookingId,
    ownerId,
    actorType: 'owner',
    force: isLateOverride,
  });

  return {
    booking: result.booking,
    changed: result.changed,
    // A duplicate check-in is reported as a state, not an error. Two operators
    // tapping at once must not produce a red screen for the second one.
    already_checked_in: !result.changed,
    was_late_override: isLateOverride,
  };
}

async function checkOutBooking({ ownerId, bookingId }) {
  await assertOwnsBooking({ ownerId, bookingId });

  const result = await bookingService.checkOut({
    bookingId,
    ownerId,
    actorType: 'owner',
  });

  return {
    booking: result.booking,
    settlement: result.settlement,
    changed: result.changed,
    already_completed: !result.changed,
  };
}

/**
 * What check-out will cost, before performing it.
 *
 * Uses `pricingService.finalAmount` — the same function the check-out itself uses —
 * so the figure the operator reads to the customer is the figure charged. There is
 * no second billing algorithm anywhere in the operator app.
 */
async function checkOutPreview({ ownerId, bookingId }) {
  const row = await assertOwnsBooking({ ownerId, bookingId });

  if (row.status !== 'CHECKED_IN') {
    throw conflict(
      `This booking is ${statusLabel(row.status).toLowerCase()} and cannot be checked out`,
      'NOT_CHECKED_IN',
      { status: row.status }
    );
  }

  const area = await parkingRepository.findRawById(row.parking_id);
  const now = time.nowUtc();

  const settlement = pricingService.finalAmount({
    booking: { ...row, entry_time: row.checked_in_at || row.entry_time },
    exitAt: now,
    parkingArea: area,
  });

  return {
    booking_id: row.id,
    code: row.booking_code,
    entry_at: time.toIso(row.checked_in_at || row.entry_time),
    exit_at: time.toIso(now),
    parked_minutes: settlement.parked_minutes,
    reserved_minutes: settlement.reserved_minutes,
    overstay_minutes: settlement.overstay_minutes,

    reserved_paise: settlement.reserved_paise,
    reserved_display: money.formatPaise(settlement.reserved_paise),
    overstay_paise: settlement.overstay_paise,
    overstay_display:
      settlement.overstay_paise > 0 ? money.formatPaise(settlement.overstay_paise) : null,
    total_paise: settlement.total_paise,
    total_display: money.formatPaise(settlement.total_paise),

    // How the number was arrived at, in words, so the operator can explain it.
    rule: settlement.rule,
    already_paid_paise: row.amount_paise ?? 0,
    balance_due_paise: Math.max(0, settlement.total_paise - (row.amount_paise ?? 0)),
    balance_due_display: money.formatPaise(
      Math.max(0, settlement.total_paise - (row.amount_paise ?? 0))
    ),
  };
}

/**
 * Closes a booking whose holder never arrived.
 *
 * A status transition with an audit event, like everything else — never a delete.
 * The old sweeper hard-deleted unverified bookings with no archive at all.
 */
async function markNoShow({ ownerId, bookingId, reason = null }) {
  const row = await assertOwnsBooking({ ownerId, bookingId });

  const entry = time.parseInstant(row.entry_time);
  if (!canMarkNoShow({ status: row.status, entry })) {
    throw conflict(
      'This booking cannot be marked as a no-show yet. Wait until the arrival window has passed.',
      'TOO_EARLY_FOR_NO_SHOW'
    );
  }

  const result = await db.withTransaction(async (tx) => {
    const moved = await bookingRepository.transition({
      bookingId,
      from: ['CONFIRMED'],
      to: 'NO_SHOW',
      client: tx,
    });

    if (!moved) {
      const current = await bookingRepository.findByIdUnscoped(bookingId, tx);
      return { row: current, changed: false };
    }

    await bookingRepository.recordEvent(
      {
        bookingId,
        eventType: 'no_show',
        fromStatus: 'CONFIRMED',
        toStatus: 'NO_SHOW',
        actorType: 'owner',
        actorId: ownerId,
        metadata: { reason, marked_manually: true },
      },
      tx
    );

    const current = await bookingRepository.findByIdUnscoped(bookingId, tx);
    return { row: current, changed: true };
  });

  if (result.changed && result.row) {
    gateway.emitSlotUpdate({
      parkingAreaId: result.row.parking_id,
      vehicleType: result.row.vehicle_type,
      slotId: result.row.parking_slot_id,
      slotNumber: result.row.slot_number,
      slotCode: result.row.slot_code,
      status: 'available',
    });
    gateway.emitBookingUpdate(result.row.user_id, bookingService.serializeBooking(result.row));
    gateway.emitOwnerBookingUpdate(ownerId, {
      type: 'no_show',
      booking: bookingService.serializeBooking(result.row),
    });
  }

  return { booking: bookingService.serializeBooking(result.row), changed: result.changed };
}

/**
 * Confirms the booking belongs to a lot this operator owns.
 *
 * Returns the row, so callers do not fetch it twice. Throws NOT FOUND — never
 * FORBIDDEN — for a booking at someone else's lot, for the same reason as the code
 * lookup: a distinguishable error is an information leak.
 */
async function assertOwnsBooking({ ownerId, bookingId, client = null }) {
  const row = await bookingRepository.findByIdUnscoped(bookingId, client);
  if (!row) throw notFound('That booking could not be found', 'BOOKING_NOT_FOUND');

  const owns = await ownerRepository.ownsParkingArea(ownerId, row.parking_id, client);
  if (!owns) {
    logger.warn(
      { ownerId, bookingId, parkingAreaId: row.parking_id },
      'Operator attempted to act on a booking outside their parking areas'
    );
    throw notFound('That booking could not be found', 'BOOKING_NOT_FOUND');
  }

  return row;
}

/* ── live grid ─────────────────────────────────────────────────────────────── */

/**
 * The slot layout, with who is in each space.
 *
 * Grouped into rows here rather than in the client, so the operator grid and the
 * customer slot picker are laid out from the same server-side ordering.
 */
async function getLiveGrid({ ownerId, parkingAreaId = null, vehicleType = null }) {
  const area = await resolveParkingArea({ ownerId, parkingAreaId });
  const slots = await operatorRepository.liveGrid({ parkingAreaId: area.id, vehicleType });

  const rowMap = new Map();
  const counts = {
    available: 0, held: 0, reserved: 0, pending_payment: 0,
    occupied: 0, out_of_service: 0,
  };

  for (const slot of slots) {
    counts[slot.state] = (counts[slot.state] ?? 0) + 1;

    const key = `${slot.vehicle_type}:${slot.row_label}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, { label: slot.row_label, vehicle_type: slot.vehicle_type, slots: [] });
    }
    rowMap.get(key).slots.push(serializeGridSlot(slot));
  }

  return {
    parking_area: { id: area.id, name: area.name },
    vehicle_type: vehicleType,
    counts,
    total: slots.length,
    rows: [...rowMap.values()].sort(
      (a, b) =>
        a.vehicle_type.localeCompare(b.vehicle_type) || a.label.localeCompare(b.label)
    ),
    generated_at: time.toIso(time.nowUtc()),
  };
}

/**
 * A grid tile.
 *
 * Carries the plate and booking code — the operator needs to match a slot to a car
 * — but no customer name or contact. Standing at a grid is not a reason to see
 * fifty people's details; the verification view is.
 */
function serializeGridSlot(slot) {
  return {
    id: slot.id,
    code: slot.code,
    row_label: slot.row_label,
    position: slot.position,
    slot_number: slot.slot_number,
    slot_class: slot.slot_class,
    vehicle_type: slot.vehicle_type,
    state: slot.state,
    state_label: gridStateLabel(slot.state),
    is_active: slot.is_active === true,
    closed_reason: slot.closed_reason ?? null,

    occupancy: slot.booking_id
      ? {
          booking_id: slot.booking_id,
          booking_code: slot.booking_code,
          booking_status: slot.booking_status,
          number_plate: slot.number_plate || null,
          entry_time: time.toIso(slot.entry_time),
          expected_exit_time: time.toIso(slot.expected_exit_time),
          checked_in_at: slot.checked_in_at ? time.toIso(slot.checked_in_at) : null,
          is_overstaying:
            slot.booking_status === 'CHECKED_IN' &&
            slot.expected_exit_time != null &&
            time.isBefore(time.parseInstant(slot.expected_exit_time), time.nowUtc()),
        }
      : null,

    hold: slot.hold_id
      ? {
          id: slot.hold_id,
          expires_at: time.toIso(slot.hold_expires_at),
          seconds_remaining: Math.max(
            0,
            time.diffSeconds(time.parseInstant(slot.hold_expires_at), time.nowUtc()) ?? 0
          ),
        }
      : null,
  };
}

function gridStateLabel(state) {
  switch (state) {
    case 'available':       return 'Available';
    case 'held':            return 'Being booked';
    case 'reserved':        return 'Reserved';
    case 'pending_payment': return 'Awaiting payment';
    case 'occupied':        return 'Occupied';
    case 'out_of_service':  return 'Out of service';
    default:                return state;
  }
}

async function getSlotDetail({ ownerId, slotId }) {
  const slot = await slotRepository.findById(slotId);
  if (!slot) throw notFound('That slot could not be found', 'SLOT_NOT_FOUND');

  const owns = await ownerRepository.ownsParkingArea(ownerId, slot.parking_area_id);
  if (!owns) throw notFound('That slot could not be found', 'SLOT_NOT_FOUND');

  const detail = await operatorRepository.slotDetail({ slotId });
  if (!detail) throw notFound('That slot could not be found', 'SLOT_NOT_FOUND');

  return serializeGridSlot(detail);
}

/* ── bookings list ─────────────────────────────────────────────────────────── */

const OPERATOR_FILTERS = {
  today: null, // resolved to a time range below
  upcoming: ['CONFIRMED'],
  active: ['CHECKED_IN'],
  completed: ['COMPLETED', 'NO_SHOW'],
  cancelled: ['CANCELLED', 'EXPIRED'],
};

async function listBookings({
  ownerId,
  parkingAreaId = null,
  filter = 'today',
  search = null,
  limit = 30,
  offset = 0,
}) {
  const areas = await ownedParkingAreas(ownerId);
  if (areas.length === 0) {
    throw notFound('No parking area is linked to your account yet.', 'NO_PARKING_AREA');
  }

  const areaIds =
    parkingAreaId === null || parkingAreaId === undefined
      ? areas.map((a) => Number(a.id))
      : [(await resolveParkingArea({ ownerId, parkingAreaId })).id];

  const area = areas.find((a) => Number(a.id) === Number(areaIds[0])) ?? areas[0];
  const dayStart = localDayStart(area.timezone_offset_minutes);

  let statuses = OPERATOR_FILTERS[filter] ?? null;
  let fromTime = null;
  let toTime = null;

  if (filter === 'today') {
    fromTime = dayStart;
    toTime = time.addMinutes(dayStart, 24 * 60);
    statuses = null;
  } else if (filter === 'upcoming') {
    fromTime = time.nowUtc();
  }

  const rows = await operatorRepository.listBookings({
    parkingAreaIds: areaIds,
    statuses,
    fromTime,
    toTime,
    // A search overrides the filter's time range: looking for a specific booking
    // should not silently exclude it for being yesterday.
    ...(search ? { fromTime: null, toTime: null, statuses: null } : {}),
    search,
    limit,
    offset,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const counts = await operatorRepository.bookingCounts({
    parkingAreaIds: areaIds,
    dayStartedAt: dayStart,
  });

  return {
    items: page.map((r) => serializeArrival(r)),
    counts,
    page: { limit, offset, has_more: hasMore },
    filter,
  };
}

/** Midnight in the lot's local day, expressed as an instant. */
function localDayStart(offsetMinutes) {
  const offset = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 330;
  const shifted = time.addMinutes(time.nowUtc(), offset);
  const midnight = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  );
  return time.addMinutes(midnight, -offset);
}

async function getBookingDetail({ ownerId, bookingId }) {
  const row = await assertOwnsBooking({ ownerId, bookingId });
  const events = await bookingRepository.listEvents(bookingId);

  return {
    ...serializeArrival(row, { full: true }),
    verification: verificationFor(row),
    // The operator's timeline is fuller than the customer's: they need to see who
    // did what, which is the point of an audit trail.
    timeline: events.map((e) => ({
      type: e.event_type,
      from_status: e.from_status,
      to_status: e.to_status,
      actor_type: e.actor_type,
      at: time.toIso(e.created_at),
    })),
  };
}

/* ── profile ───────────────────────────────────────────────────────────────── */

/** The operator and their lots. Drives the profile screen and the lot switcher. */
async function getProfile({ ownerId }) {
  const [owner, areas] = await Promise.all([
    ownerRepository.findById(ownerId),
    ownedParkingAreas(ownerId),
  ]);

  if (!owner) throw notFound('Your account could not be found', 'OWNER_NOT_FOUND');

  return {
    owner: {
      id: owner.id,
      name: owner.name,
      phone: owner.phone,
      email: owner.email ?? null,
      must_reset_password: owner.must_reset_password === true,
    },
    parking_areas: areas.map((a) => ({
      id: a.id,
      name: a.name,
      address_line: a.address_line ?? null,
      locality: a.locality ?? null,
      city: a.city ?? null,
      is_active: a.is_active !== false,
      total_car_slots: a.total_car_slots ?? 0,
      total_bike_slots: a.total_bike_slots ?? 0,
      base_car_price_paise: a.base_car_price_paise ?? null,
      base_bike_price_paise: a.base_bike_price_paise ?? null,
      rating: a.rating_avg === null ? null : Number(a.rating_avg),
      rating_count: a.rating_count ?? 0,
    })),
  };
}

module.exports = {
  // authorisation
  ownedParkingAreas,
  ownedParkingAreaIds,
  resolveParkingArea,
  assertOwnsBooking,
  // screens
  getDashboard,
  getArrivals,
  lookupBooking,
  lookupByPlate,
  getLiveGrid,
  getSlotDetail,
  listBookings,
  getBookingDetail,
  getProfile,
  // actions
  checkInBooking,
  checkOutBooking,
  checkOutPreview,
  markNoShow,
  // exported for tests
  _internal: { normaliseCode, maskPhone, arrivalState, verificationFor, canOperatorCheckIn },
};
