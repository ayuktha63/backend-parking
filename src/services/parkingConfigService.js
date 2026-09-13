'use strict';

/**
 * Parking configuration.
 *
 * ONE RULE GOVERNS THIS FILE: a configuration change must never silently invalidate
 * a reservation somebody has paid for.
 *
 * The system this replaces did exactly that. `POST /api/owner/parking_areas` found
 * a lot by `WHERE name = $1` — no owner check at all — and when the slot count
 * changed it ran:
 *
 *     DELETE FROM slots    WHERE parking_id = $1
 *     DELETE FROM bookings WHERE parking_id = $1
 *
 * with no archival, no transaction and no notification. Every booking in the lot
 * vanished, including ones in progress, because a number in a form changed.
 *
 * The replacement is a three-step protocol for anything that can strand a booking:
 *
 *   1. PREVIEW   the server computes the impact and returns it with a hash
 *   2. REVIEW    the operator sees exactly what will happen, in full
 *   3. APPLY     the operator returns the hash; the server recomputes the impact
 *                inside a locked transaction and refuses if anything moved
 *
 * Step 3 is what makes this safe rather than merely polite. The impact is never
 * taken from the client — only the hash is, and it is used solely to detect that
 * the world changed underneath the operator.
 */

const crypto = require('crypto');

const { config } = require('../config');
const db = require('../db');
const configRepository = require('../repositories/configRepository');
const operatorRepository = require('../repositories/operatorRepository');
const slotRepository = require('../repositories/slotRepository');
const operatorService = require('./operatorService');
const gateway = require('../sockets/gateway');
const time = require('../utils/time');
const money = require('../utils/money');
const { logger } = require('../utils/logger');
const { badRequest, notFound, conflict, DomainErrors } = require('../utils/errors');
const parkingPhotoService = require('./parkingPhotoService');

/** How long a preview is honoured. Long enough to read, short enough to be current. */
const PREVIEW_TTL_SECONDS = 300;

/* ── the impact hash ───────────────────────────────────────────────────────── */

/**
 * Fingerprints everything that would make a reviewed impact wrong.
 *
 * Not a security measure — the operator is already authenticated and authorised.
 * It is a consistency measure, and it must cover every input to the decision the
 * operator made:
 *
 *   - what they asked for (lot, vehicle type, target capacity)
 *   - the state they were shown (current counts, the exact slots to be closed)
 *   - the reservations they were told about (booking ids, hold ids)
 *   - the lot's `updated_at`, so a DIFFERENT operator changing anything at all
 *     invalidates this preview too
 *
 * A customer booking one of the doomed slots changes `affected_booking_ids`; a
 * second operator editing pricing changes `updated_at`. Either way the hash moves
 * and the apply is refused.
 */
function computeImpactHash(material) {
  const canonical = JSON.stringify(material, Object.keys(material).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Builds the hash material for a capacity change.
 *
 * Arrays are sorted so that a different row order from Postgres — which is not
 * guaranteed without ORDER BY, and which the queries do specify, but belt and
 * braces — cannot produce a spurious mismatch.
 */
function capacityHashMaterial({ parkingAreaId, vehicleType, target, snapshot, updatedAt }) {
  return {
    kind: 'capacity',
    parking_area_id: Number(parkingAreaId),
    vehicle_type: vehicleType,
    target,
    current_total: snapshot.total_slots ?? 0,
    current_active: snapshot.active_slots ?? 0,
    max_slot_number: snapshot.max_slot_number ?? 0,
    closing_slot_ids: [...(snapshot.closing_slot_ids ?? [])].map(Number).sort((a, b) => a - b),
    affected_booking_ids: [...(snapshot.affected_booking_ids ?? [])].map(Number).sort((a, b) => a - b),
    affected_hold_ids: [...(snapshot.affected_hold_ids ?? [])].map(Number).sort((a, b) => a - b),
    // Any write to the lot bumps this via the attach_updated_at trigger.
    lot_version: updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt),
  };
}

/* ── configuration read ────────────────────────────────────────────────────── */

/** Everything the configuration screen renders, plus the amenity catalogue. */
async function getConfiguration({ ownerId, parkingAreaId = null }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });

  const [row, amenityCatalogue, carSlots, bikeSlots] = await Promise.all([
    configRepository.getConfiguration(area.id),
    configRepository.listAmenityCatalogue(),
    slotRepository.countSlots({ parkingAreaId: area.id, vehicleType: 'car' }),
    slotRepository.countSlots({ parkingAreaId: area.id, vehicleType: 'bike' }),
  ]);

  if (!row) throw notFound('That parking area could not be found', 'PARKING_NOT_FOUND');

  return {
    parking_area_id: row.id,

    information: {
      name: row.name,
      description: row.description ?? null,
      instructions: row.instructions ?? null,
      address_line: row.address_line ?? null,
      locality: row.locality ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      postal_code: row.postal_code ?? null,
      landmark: row.landmark ?? null,
      contact_phone: row.contact_phone ?? null,
      location:
        row.lat === null || row.lat === undefined
          ? null
          : { lat: Number(row.lat), lng: Number(row.lng) },
    },

    pricing: {
      car_paise: row.base_car_price_paise ?? null,
      car_display:
        row.base_car_price_paise === null || row.base_car_price_paise === undefined
          ? null
          : money.formatPaise(row.base_car_price_paise),
      bike_paise: row.base_bike_price_paise ?? null,
      bike_display:
        row.base_bike_price_paise === null || row.base_bike_price_paise === undefined
          ? null
          : money.formatPaise(row.base_bike_price_paise),
      // The fallbacks used when a lot has none configured, so the operator can see
      // what customers are currently being charged rather than a blank.
      fallback_car_paise: config.pricing.fallbackBasePaise.car,
      fallback_bike_paise: config.pricing.fallbackBasePaise.bike,
      // Demand pricing is engine-wide, not per lot. Stated plainly so the operator
      // is not looking for a switch that does not exist.
      dynamic_pricing: {
        enabled: config.pricing.maxMultiplier > config.pricing.minMultiplier,
        max_multiplier: config.pricing.maxMultiplier,
        is_per_lot_configurable: false,
        explanation:
          'PARQX raises the hourly rate when your lot is filling up, to at most ' +
          `${config.pricing.maxMultiplier}× your base price. It never charges less than ` +
          'your base price. This is set platform-wide and is not configurable per lot.',
      },
      overstay_half_hour_paise: config.pricing.overstayHalfHourPaise,
    },

    capacity: {
      car: {
        configured: row.total_car_slots ?? 0,
        slots_total: carSlots.total,
        slots_active: carSlots.active,
        // A mismatch means the counter and the real rows disagree — worth showing,
        // because it is the thing a capacity change reconciles.
        needs_reconcile: (row.total_car_slots ?? 0) !== carSlots.active,
      },
      bike: {
        configured: row.total_bike_slots ?? 0,
        slots_total: bikeSlots.total,
        slots_active: bikeSlots.active,
        needs_reconcile: (row.total_bike_slots ?? 0) !== bikeSlots.active,
      },
    },

    hours: {
      is_open_24_7: row.is_open_24_7 === true,
      timezone_offset_minutes: row.timezone_offset_minutes,
      // Empty means every day is closed; `is_open_24_7` overrides. A lot with no
      // rows and the flag off is genuinely never open, which the UI must say.
      days: (row.opening_hours || []).map((d) => ({
        day_of_week: d.day_of_week,
        opens_at: String(d.opens_at).slice(0, 5),
        closes_at: String(d.closes_at).slice(0, 5),
        closes_next_day: d.closes_next_day === true,
      })),
    },

    amenities: {
      selected: row.amenity_codes || [],
      catalogue: amenityCatalogue.map((a) => ({
        code: a.code,
        label: a.label,
        icon: a.icon ?? null,
      })),
    },

    // Upload exists now; see services/parkingPhotoService. The client reads
    // these limits rather than hardcoding them, so raising the cap or adding a
    // format is a server-side change.
    photos: {
      count: row.photo_count ?? 0,
      upload_supported: true,
      max_photos: parkingPhotoService.MAX_PHOTOS_PER_AREA,
      max_bytes: parkingPhotoService.MAX_BYTES,
      accepted_types: parkingPhotoService.ACCEPTED_TYPES,
    },

    is_active: row.is_active !== false,
    max_duration_minutes: row.max_duration_minutes ?? config.booking.maxDurationMinutes,

    // The optimistic-concurrency token every write must return.
    version: time.toIso(row.updated_at),
  };
}

/** The configuration view of the layout: every slot, and what constrains it. */
async function getConfigurationGrid({ ownerId, parkingAreaId = null, vehicleType = null }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });
  const slots = await configRepository.configurationGrid({
    parkingAreaId: area.id,
    vehicleType,
  });

  const rowMap = new Map();
  for (const slot of slots) {
    const key = `${slot.vehicle_type}:${slot.row_label}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, { label: slot.row_label, vehicle_type: slot.vehicle_type, slots: [] });
    }
    rowMap.get(key).slots.push({
      id: slot.id,
      code: slot.code,
      row_label: slot.row_label,
      position: slot.position,
      slot_number: slot.slot_number,
      slot_class: slot.slot_class,
      vehicle_type: slot.vehicle_type,
      is_active: slot.is_active === true,
      closed_reason: slot.closed_reason ?? null,
      upcoming_bookings: slot.upcoming_bookings ?? 0,
      is_held: slot.is_held === true,
      // Computed here so the button state and the refusal come from one rule.
      can_close: slot.is_active === true && (slot.upcoming_bookings ?? 0) === 0 && !slot.is_held,
      can_reopen: slot.is_active !== true,
    });
  }

  return {
    parking_area: { id: area.id, name: area.name },
    rows: [...rowMap.values()].sort(
      (a, b) => a.vehicle_type.localeCompare(b.vehicle_type) || a.label.localeCompare(b.label)
    ),
    total: slots.length,
  };
}

/* ── capacity: preview ─────────────────────────────────────────────────────── */

/**
 * Computes what a capacity change would do, without doing it.
 *
 * The returned `impact_hash` is the operator's receipt: handing it back with the
 * apply request asserts "this is the change I reviewed". The server checks that
 * claim against freshly-computed state rather than believing it.
 */
async function previewCapacityChange({ ownerId, parkingAreaId = null, vehicleType, target }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });

  if (!Number.isInteger(target) || target < 0) {
    throw badRequest('Capacity must be zero or more', undefined, 'INVALID_CAPACITY');
  }
  if (target > 2000) {
    throw badRequest('A single parking area cannot exceed 2000 slots', undefined, 'CAPACITY_TOO_LARGE');
  }

  const current = await slotRepository.countSlots({ parkingAreaId: area.id, vehicleType });
  const lot = await configRepository.getConfiguration(area.id);

  // Slots numbered above the target are the ones a reduction closes.
  const fromNumber = target + 1;

  const snapshot = await configRepository.capacitySnapshot({
    parkingAreaId: area.id,
    vehicleType,
    fromNumber,
  });

  const isReduction = target < current.active;
  const isIncrease = target > current.active;

  const affectedBookings = isReduction
    ? await configRepository.affectedBookings({
        parkingAreaId: area.id,
        vehicleType,
        fromNumber,
      })
    : [];

  const closingCount = (snapshot.closing_slot_ids || []).length;
  const affectedHolds = (snapshot.affected_hold_ids || []).length;

  const blockers = [];
  if (isReduction && affectedBookings.length > 0) {
    blockers.push({
      code: 'BOOKINGS_AFFECTED',
      message:
        `${affectedBookings.length} reservation${affectedBookings.length === 1 ? '' : 's'} ` +
        'would be stranded by this reduction.',
    });
  }
  if (isReduction && affectedHolds > 0) {
    blockers.push({
      code: 'SLOTS_HELD',
      message:
        `${affectedHolds} slot${affectedHolds === 1 ? ' is' : 's are'} being booked right now. ` +
        'Try again in a couple of minutes.',
    });
  }

  const impactHash = computeImpactHash(
    capacityHashMaterial({
      parkingAreaId: area.id,
      vehicleType,
      target,
      snapshot,
      updatedAt: lot.updated_at,
    })
  );

  return {
    parking_area: { id: area.id, name: area.name },
    vehicle_type: vehicleType,

    current: {
      configured: vehicleType === 'bike' ? lot.total_bike_slots : lot.total_car_slots,
      active_slots: current.active,
      total_slots: current.total,
      max_slot_number: current.max_number,
    },
    target,

    direction: isIncrease ? 'increase' : isReduction ? 'reduce' : 'unchanged',

    // What will physically happen. Increases reuse previously-closed slot numbers
    // before creating new ones, which is why this is two figures.
    change: {
      slots_to_close: isReduction ? closingCount : 0,
      closing_slot_codes: isReduction ? snapshot.closing_slot_codes || [] : [],
      slots_to_reopen: isIncrease ? Math.min(target, current.total) - current.active : 0,
      slots_to_create: isIncrease ? Math.max(0, target - Math.max(current.total, current.active)) : 0,
    },

    // The reservations. An empty list is the answer "nobody is affected", stated
    // explicitly rather than implied by the absence of a warning.
    affected_bookings: affectedBookings.map((b) => ({
      id: b.id,
      code: b.booking_code,
      status: b.status,
      slot_code: b.slot_code,
      number_plate: b.number_plate || null,
      entry_time: time.toIso(b.entry_time),
      expected_exit_time: time.toIso(b.expected_exit_time),
    })),
    affected_booking_count: affectedBookings.length,
    affected_hold_count: affectedHolds,

    can_apply: blockers.length === 0 && (isIncrease || isReduction),
    blockers,

    impact_hash: impactHash,
    expires_at: time.toIso(time.addSeconds(time.nowUtc(), PREVIEW_TTL_SECONDS)),
    // Echoed so the UI can show "reviewed at", and so a stale preview is obvious.
    generated_at: time.toIso(time.nowUtc()),
  };
}

/* ── capacity: apply ───────────────────────────────────────────────────────── */

/**
 * Applies a reviewed capacity change.
 *
 * Everything happens inside one transaction holding the parking area's advisory
 * lock, and the impact is recomputed from scratch before anything is written. The
 * client's hash is compared against that recomputation — it is never used as input
 * to the decision, only as a claim about what the operator saw.
 *
 * Scenario A (customer books between preview and confirm): the booking id joins
 * `affected_booking_ids`, the hash moves, refused.
 * Scenario B (another operator edits anything): `updated_at` moves, hash moves,
 * refused.
 * Scenario C/D (slots are booked): blockers are non-empty, refused with the list.
 * Scenario E (a booking lands mid-apply): the advisory lock serialises them, and
 * the booking either happens before the recomputation sees it, or after the commit.
 */
async function applyCapacityChange({ ownerId, parkingAreaId = null, vehicleType, target, impactHash }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });

  if (!impactHash) {
    throw badRequest(
      'Review the impact of this change before applying it',
      undefined,
      'IMPACT_HASH_REQUIRED'
    );
  }

  // Details of a refusal, set inside the transaction and written to the audit log
  // after it has rolled back. An audit trail that only survives successes cannot
  // demonstrate that anything was ever protected — and the refusals are the whole
  // point of this mechanism.
  let refusal = null;

  let result;
  try {
    result = await db.withTransaction(async (tx) => {
    // Serialise configuration changes on this lot against each other AND against
    // the booking path, which takes a slot-scoped lock. This is the lock that makes
    // Scenario E produce no partial state.
    await db.advisoryXactLock(tx, 'parking-config', area.id);

    const lot = await configRepository.lockForUpdate(area.id, tx);
    if (!lot) throw notFound('That parking area could not be found', 'PARKING_NOT_FOUND');

    const current = await slotRepository.countSlots({
      parkingAreaId: area.id,
      vehicleType,
      client: tx,
    });

    const fromNumber = target + 1;
    const snapshot = await configRepository.capacitySnapshot({
      parkingAreaId: area.id,
      vehicleType,
      fromNumber,
      client: tx,
    });

    // Recomputed, not trusted.
    const freshHash = computeImpactHash(
      capacityHashMaterial({
        parkingAreaId: area.id,
        vehicleType,
        target,
        snapshot,
        updatedAt: lot.updated_at,
      })
    );

    if (freshHash !== impactHash) {
      logger.info(
        { ownerId, parkingAreaId: area.id, vehicleType, target },
        'Capacity apply refused — impact changed since preview'
      );
      // Recorded AFTER this transaction rolls back — see the catch below. Writing
      // it here would enrol the audit row in the very transaction whose rollback
      // is the refusal, so the record of the refusal would be destroyed by it.
      refusal = { reason: 'impact_hash_mismatch', vehicle_type: vehicleType, target };
      throw DomainErrors.impactChanged();
    }

    const affectedBookingIds = snapshot.affected_booking_ids || [];
    const affectedHoldIds = snapshot.affected_hold_ids || [];
    const isReduction = target < current.active;

    // The absolute rule. Nothing below this line deletes a booking, and this guard
    // is what guarantees nothing needs to.
    if (isReduction && (affectedBookingIds.length > 0 || affectedHoldIds.length > 0)) {
      refusal = {
        reason: 'reservations_affected',
        vehicle_type: vehicleType,
        from: current.active,
        to: target,
        affected_bookings: affectedBookingIds.length,
        affected_holds: affectedHoldIds.length,
      };
      throw DomainErrors.capacityReductionBlocked({
        affected_bookings: affectedBookingIds.length,
        affected_holds: affectedHoldIds.length,
      });
    }

    let closed = [];
    let reopened = [];
    let created = [];

    if (isReduction) {
      // Soft close. The rows survive with `is_active = false`, so the history of
      // which slot a past booking used is never orphaned.
      closed = await slotRepository.closeSlots(
        { parkingAreaId: area.id, vehicleType, fromNumber, reason: 'capacity_reduced' },
        tx
      );
    } else if (target > current.active) {
      // Reopen previously-closed numbers first — reusing A12 is better than
      // inventing a second A12 — then create whatever is still missing.
      reopened = await slotRepository.reopenSlots(
        { parkingAreaId: area.id, vehicleType, toNumber: target },
        tx
      );

      if (target > current.total) {
        created = await slotRepository.createSlots(
          {
            parkingAreaId: area.id,
            vehicleType,
            fromNumber: current.total + 1,
            toNumber: target,
          },
          tx
        );
      }
    }

    await configRepository.setCapacityCounter(
      { parkingAreaId: area.id, vehicleType, total: target },
      tx
    );

    await operatorRepository.recordAudit(
      {
        parkingAreaId: area.id,
        ownerId,
        eventType: isReduction ? 'capacity_reduced' : 'capacity_increased',
        detail: {
          vehicle_type: vehicleType,
          from: current.active,
          to: target,
          closed_slot_codes: closed.map((s) => s.code),
          reopened_slot_codes: reopened.map((s) => s.code),
          created_slot_codes: created.map((s) => s.code),
          impact_hash: impactHash,
        },
      },
      tx
    );

    return {
      closed: closed.map((s) => ({ id: s.id, code: s.code })),
      reopened: reopened.map((s) => ({ id: s.id, code: s.code })),
      created: created.map((s) => ({ id: s.id, code: s.code })),
      from: current.active,
      to: target,
    };
    });
  } catch (err) {
    if (refusal) {
      // Best effort on its own connection, outside the rolled-back transaction.
      // A failure to record the refusal must not replace the refusal's own error,
      // which is the one the operator needs to see.
      await operatorRepository
        .recordAudit({
          parkingAreaId: area.id,
          ownerId,
          eventType: 'capacity_reduction_blocked',
          detail: refusal,
        })
        .catch((auditErr) =>
          logger.error({ err: auditErr, parkingAreaId: area.id }, 'Could not record refusal')
        );
    }
    throw err;
  }

  // Emitted after commit: a subscriber that refetches on an event must not be able
  // to read a state that has not been written yet.
  for (const slot of result.closed) {
    gateway.emitSlotUpdate({
      parkingAreaId: area.id,
      vehicleType,
      slotId: slot.id,
      slotCode: slot.code,
      status: 'closed',
    });
  }
  for (const slot of [...result.reopened, ...result.created]) {
    gateway.emitSlotUpdate({
      parkingAreaId: area.id,
      vehicleType,
      slotId: slot.id,
      slotCode: slot.code,
      status: 'available',
    });
  }
  gateway.emitParkingConfigChanged(area.id, {
    change: 'capacity',
    vehicle_type: vehicleType,
    from: result.from,
    to: result.to,
  });

  return {
    applied: true,
    ...result,
    configuration: await getConfiguration({ ownerId, parkingAreaId: area.id }),
  };
}

/* ── slot service state ────────────────────────────────────────────────────── */

/**
 * Closes or reopens one slot.
 *
 * The same rule as capacity, at single-slot granularity: a slot with an upcoming
 * reservation cannot be closed, and the refusal names the bookings rather than
 * greying out a button with no explanation.
 *
 * Replaces `operatorService.setSlotServiceState`, which enforced the same guard but
 * outside a transaction and without an ownership-scoped lock.
 */
async function setSlotServiceState({ ownerId, slotId, isActive, reason = null }) {
  const slot = await slotRepository.findById(slotId);
  if (!slot) throw notFound('That slot could not be found', 'SLOT_NOT_FOUND');

  // NOT FOUND rather than FORBIDDEN, for the same reason as everywhere else in the
  // operator surface: a distinguishable error confirms a record exists.
  const areas = await operatorService.ownedParkingAreaIds(ownerId);
  if (!areas.includes(Number(slot.parking_area_id))) {
    throw notFound('That slot could not be found', 'SLOT_NOT_FOUND');
  }

  const outcome = await db.withTransaction(async (tx) => {
    await db.advisoryXactLock(tx, 'slot', slotId);

    if (!isActive) {
      const bookings = await configRepository.bookingsOnSlot({ slotId, client: tx });

      if (bookings.length > 0) {
        await operatorRepository.recordAudit(
          {
            parkingAreaId: slot.parking_area_id,
            ownerId,
            eventType: 'capacity_reduction_blocked',
            detail: {
              scope: 'single_slot',
              slot_code: slot.code,
              affected_bookings: bookings.length,
            },
          },
          tx
        );

        throw conflict(
          `Slot ${slot.code} has ${bookings.length} upcoming ` +
            `reservation${bookings.length === 1 ? '' : 's'} and cannot be closed.`,
          'SLOT_HAS_BOOKINGS',
          {
            slot_code: slot.code,
            affected: bookings.map((b) => ({
              code: b.booking_code,
              status: b.status,
              entry_time: time.toIso(b.entry_time),
              number_plate: b.number_plate || null,
            })),
          }
        );
      }
    }

    const updated = await db.queryOne(
      `UPDATE parking_slots
          SET is_active = $2,
              closed_reason = CASE WHEN $2 THEN NULL ELSE $3 END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, code, is_active, closed_reason, vehicle_type, parking_area_id`,
      [slotId, isActive, reason ? String(reason).slice(0, 200) : 'out_of_service'],
      tx
    );

    await operatorRepository.recordAudit(
      {
        parkingAreaId: slot.parking_area_id,
        ownerId,
        eventType: isActive ? 'slot_reopened' : 'slot_closed',
        detail: { slot_id: slotId, slot_code: slot.code, reason },
      },
      tx
    );

    return updated;
  });

  gateway.emitSlotUpdate({
    parkingAreaId: slot.parking_area_id,
    vehicleType: slot.vehicle_type,
    slotId: slot.id,
    slotNumber: slot.slot_number,
    slotCode: slot.code,
    status: isActive ? 'available' : 'closed',
  });

  return {
    slot: {
      id: outcome.id,
      code: outcome.code,
      is_active: outcome.is_active,
      closed_reason: outcome.closed_reason,
    },
  };
}

/* ── pricing ───────────────────────────────────────────────────────────────── */

/**
 * What a price change would and would not do.
 *
 * The honest claim, and the reason this preview exists: existing reservations are
 * NOT repriced. Each booking stores a `pricing_snapshot` taken when it was made,
 * and `bookingService.createFromHold` honours it. So the preview can state, as
 * fact rather than reassurance, that N confirmed bookings keep their price.
 */
async function previewPricingChange({ ownerId, parkingAreaId = null, carPaise, bikePaise }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });
  const lot = await configRepository.getConfiguration(area.id);

  assertPrice(carPaise, 'car');
  assertPrice(bikePaise, 'bike');

  const lockedCount = await configRepository.countPriceLockedBookings({ parkingAreaId: area.id });

  const changes = [];
  if (carPaise !== null && carPaise !== undefined && carPaise !== lot.base_car_price_paise) {
    changes.push(priceChange('Car', lot.base_car_price_paise, carPaise));
  }
  if (bikePaise !== null && bikePaise !== undefined && bikePaise !== lot.base_bike_price_paise) {
    changes.push(priceChange('Bike', lot.base_bike_price_paise, bikePaise));
  }

  return {
    parking_area: { id: area.id, name: area.name },
    changes,
    has_changes: changes.length > 0,

    impact: {
      // Stated as a fact about the implemented rule, not as a promise.
      existing_bookings_repriced: false,
      existing_bookings_count: lockedCount,
      existing_bookings_note:
        lockedCount === 0
          ? 'No existing reservations are affected.'
          : `${lockedCount} existing reservation${lockedCount === 1 ? '' : 's'} keep${lockedCount === 1 ? 's' : ''} ` +
            'the price agreed when it was booked. PARQX stores the quote on the booking.',
      applies_from: 'Immediately, for new bookings only.',
      // Demand pricing multiplies the base; a rise is therefore amplified at peak.
      dynamic_note:
        `At peak demand PARQX may charge up to ${config.pricing.maxMultiplier}× your base price.`,
    },

    version: time.toIso(lot.updated_at),
  };
}

function priceChange(label, fromPaise, toPaise) {
  const from = fromPaise ?? null;
  return {
    vehicle: label,
    from_paise: from,
    from_display: from === null ? null : money.formatPaise(from),
    to_paise: toPaise,
    to_display: money.formatPaise(toPaise),
    // Null when there was no configured price before, because a percentage change
    // from "unset" is not a meaningful number.
    percent_change:
      from === null || from === 0 ? null : Math.round(((toPaise - from) / from) * 100),
  };
}

function assertPrice(paise, label) {
  if (paise === null || paise === undefined) return;
  if (!Number.isInteger(paise)) {
    throw badRequest(`${label} price must be a whole number of paise`, undefined, 'INVALID_PRICE');
  }
  if (paise < 0) throw badRequest(`${label} price cannot be negative`, undefined, 'INVALID_PRICE');
  if (paise > 10_000_00) {
    throw badRequest(`${label} price looks wrong — over ₹10,000 per hour`, undefined, 'PRICE_TOO_HIGH');
  }
  if (paise % 100 !== 0) {
    // The pricing engine rounds the hourly rate to whole rupees anyway; accepting
    // paise here would show the operator a number they never actually charge.
    throw badRequest(
      `${label} price must be a whole number of rupees`,
      undefined,
      'PRICE_NOT_WHOLE_RUPEES'
    );
  }
}

async function applyPricingChange({ ownerId, parkingAreaId = null, carPaise, bikePaise, version }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });
  assertPrice(carPaise, 'car');
  assertPrice(bikePaise, 'bike');

  await db.withTransaction(async (tx) => {
    await db.advisoryXactLock(tx, 'parking-config', area.id);
    const lot = await configRepository.lockForUpdate(area.id, tx);
    if (!lot) throw notFound('That parking area could not be found', 'PARKING_NOT_FOUND');

    assertVersion(lot.updated_at, version);

    await configRepository.updatePricing(
      { parkingAreaId: area.id, carPaise, bikePaise },
      tx
    );

    await operatorRepository.recordAudit(
      {
        parkingAreaId: area.id,
        ownerId,
        eventType: 'pricing_changed',
        detail: {
          car: { from: lot.base_car_price_paise ?? null, to: carPaise ?? lot.base_car_price_paise },
          bike: { from: lot.base_bike_price_paise ?? null, to: bikePaise ?? lot.base_bike_price_paise },
        },
      },
      tx
    );
  });

  gateway.emitParkingConfigChanged(area.id, { change: 'pricing' });

  return { applied: true, configuration: await getConfiguration({ ownerId, parkingAreaId: area.id }) };
}

/* ── opening hours ─────────────────────────────────────────────────────────── */

/**
 * Replaces the weekly schedule.
 *
 * Validated against the semantics `OPEN_NOW_EXPR` already implements, so what the
 * operator sets is what the customer's "open now" filter evaluates. Times are wall
 * clock in the lot's own zone — `timezone_offset_minutes` on the lot — which is why
 * no timezone is invented here.
 */
async function applyHoursChange({ ownerId, parkingAreaId = null, isOpen24x7, days, version }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });

  const normalised = validateDays(days);

  await db.withTransaction(async (tx) => {
    await db.advisoryXactLock(tx, 'parking-config', area.id);
    const lot = await configRepository.lockForUpdate(area.id, tx);
    if (!lot) throw notFound('That parking area could not be found', 'PARKING_NOT_FOUND');

    assertVersion(lot.updated_at, version);

    await configRepository.setOpen24x7({ parkingAreaId: area.id, isOpen24x7 }, tx);

    // A 24/7 lot keeps no day rows: two sources of truth for "when are you open"
    // is how they end up disagreeing.
    await configRepository.replaceOpeningHours(
      { parkingAreaId: area.id, days: isOpen24x7 ? [] : normalised },
      tx
    );

    await operatorRepository.recordAudit(
      {
        parkingAreaId: area.id,
        ownerId,
        eventType: 'hours_changed',
        detail: {
          is_open_24_7: isOpen24x7,
          open_days: normalised.length,
          was_open_24_7: lot.is_open_24_7 === true,
        },
      },
      tx
    );
  });

  gateway.emitParkingConfigChanged(area.id, { change: 'hours' });

  return { applied: true, configuration: await getConfiguration({ ownerId, parkingAreaId: area.id }) };
}

/**
 * Validates a week.
 *
 * An omitted day is closed — that is the schema's meaning, and the UI says so.
 * `closes_next_day` is how an overnight lot is expressed; without it a closing time
 * at or before the opening time is a mistake, not a 24-hour day.
 */
function validateDays(days) {
  if (!Array.isArray(days)) return [];

  const seen = new Set();
  const out = [];

  for (const day of days) {
    const dow = Number(day.day_of_week ?? day.dayOfWeek);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      throw badRequest('Day of week must be 0 (Sunday) to 6', undefined, 'INVALID_DAY');
    }
    if (seen.has(dow)) {
      throw badRequest('Each day can appear only once', undefined, 'DUPLICATE_DAY');
    }
    seen.add(dow);

    const opens = String(day.opens_at ?? day.opensAt ?? '');
    const closes = String(day.closes_at ?? day.closesAt ?? '');
    if (!/^\d{2}:\d{2}$/.test(opens) || !/^\d{2}:\d{2}$/.test(closes)) {
      throw badRequest('Times must be HH:MM', undefined, 'INVALID_TIME');
    }

    const closesNextDay = (day.closes_next_day ?? day.closesNextDay) === true;

    if (!closesNextDay && opens >= closes) {
      throw badRequest(
        `Closing time must be after opening time on day ${dow}. ` +
          'For a lot that closes after midnight, mark it as closing the next day.',
        undefined,
        'INVALID_TIME_RANGE'
      );
    }
    if (closesNextDay && closes >= opens) {
      throw badRequest(
        `Day ${dow} is marked as closing the next day, but the closing time is not ` +
          'after midnight.',
        undefined,
        'INVALID_OVERNIGHT_RANGE'
      );
    }

    out.push({ dayOfWeek: dow, opensAt: opens, closesAt: closes, closesNextDay });
  }

  return out.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

/* ── amenities ─────────────────────────────────────────────────────────────── */

async function applyAmenitiesChange({ ownerId, parkingAreaId = null, codes, version }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });

  const catalogue = await configRepository.listAmenityCatalogue();
  const supported = new Set(catalogue.map((a) => a.code));
  const requested = [...new Set((codes || []).map((c) => String(c).toLowerCase()))];

  const unknown = requested.filter((c) => !supported.has(c));
  if (unknown.length > 0) {
    // The FK would reject these anyway; refusing here gives a usable message
    // instead of a constraint violation.
    throw badRequest(
      `Unknown amenit${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}`,
      { unknown },
      'UNKNOWN_AMENITY'
    );
  }

  await db.withTransaction(async (tx) => {
    await db.advisoryXactLock(tx, 'parking-config', area.id);
    const lot = await configRepository.lockForUpdate(area.id, tx);
    if (!lot) throw notFound('That parking area could not be found', 'PARKING_NOT_FOUND');

    assertVersion(lot.updated_at, version);

    const before = await configRepository.getConfiguration(area.id, tx);
    await configRepository.replaceAmenities({ parkingAreaId: area.id, codes: requested }, tx);

    // Bump the lot so the version token moves for an amenity-only change too.
    await db.query('UPDATE parking_areas SET updated_at = NOW() WHERE id = $1', [area.id], tx);

    await operatorRepository.recordAudit(
      {
        parkingAreaId: area.id,
        ownerId,
        eventType: 'amenities_changed',
        detail: { from: before?.amenity_codes || [], to: requested },
      },
      tx
    );
  });

  gateway.emitParkingConfigChanged(area.id, { change: 'amenities' });

  return { applied: true, configuration: await getConfiguration({ ownerId, parkingAreaId: area.id }) };
}

/* ── details ───────────────────────────────────────────────────────────────── */

async function applyDetailsChange({ ownerId, parkingAreaId = null, patch, version }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });

  await db.withTransaction(async (tx) => {
    await db.advisoryXactLock(tx, 'parking-config', area.id);
    const lot = await configRepository.lockForUpdate(area.id, tx);
    if (!lot) throw notFound('That parking area could not be found', 'PARKING_NOT_FOUND');

    assertVersion(lot.updated_at, version);

    const before = await configRepository.getConfiguration(area.id, tx);
    await configRepository.updateDetails({ parkingAreaId: area.id, patch }, tx);

    await operatorRepository.recordAudit(
      {
        parkingAreaId: area.id,
        ownerId,
        eventType: 'details_changed',
        detail: {
          // Only the fields that actually moved, and only their own values — an
          // audit record is not a place to accumulate a copy of everything.
          changed: Object.keys(patch).filter((k) => patch[k] !== undefined && patch[k] !== null),
          name_from: before?.name ?? null,
          name_to: patch.name ?? before?.name ?? null,
        },
      },
      tx
    );
  });

  gateway.emitParkingConfigChanged(area.id, { change: 'details' });

  return { applied: true, configuration: await getConfiguration({ ownerId, parkingAreaId: area.id }) };
}

/* ── shared ────────────────────────────────────────────────────────────────── */

/**
 * Optimistic concurrency for changes that cannot strand a booking.
 *
 * Lighter than the capacity hash — there is no impact to re-verify — but it still
 * stops two operators silently overwriting each other's edits.
 */
function assertVersion(actualUpdatedAt, claimedVersion) {
  if (!claimedVersion) {
    throw badRequest(
      'Reload the settings before saving',
      undefined,
      'VERSION_REQUIRED'
    );
  }

  const actual = time.toIso(actualUpdatedAt);
  if (actual !== claimedVersion) {
    throw conflict(
      'These settings were changed elsewhere while you were editing. ' +
        'Reload to see the current values, then apply your change again.',
      'CONFIG_VERSION_STALE',
      { current_version: actual }
    );
  }
}

/** The configuration change history, for the audit view. */
async function getAuditLog({ ownerId, parkingAreaId = null, limit = 50 }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });
  const events = await operatorRepository.listAudit({ parkingAreaId: area.id, limit });

  return {
    parking_area: { id: area.id, name: area.name },
    events: events.map((e) => ({
      id: e.id,
      type: e.event_type,
      label: auditLabel(e.event_type),
      detail: e.detail || {},
      // True when this operator made the change, without exposing other owner ids.
      by_you: Number(e.owner_id) === Number(ownerId),
      at: time.toIso(e.created_at),
    })),
  };
}

function auditLabel(type) {
  switch (type) {
    case 'slot_closed':                 return 'Slot closed';
    case 'slot_reopened':               return 'Slot reopened';
    case 'capacity_increased':          return 'Capacity increased';
    case 'capacity_reduced':            return 'Capacity reduced';
    case 'capacity_reduction_blocked':  return 'Capacity change refused';
    case 'pricing_changed':             return 'Pricing changed';
    case 'hours_changed':               return 'Opening hours changed';
    case 'details_changed':             return 'Details changed';
    case 'amenities_changed':           return 'Amenities changed';
    case 'lot_activated':               return 'Parking activated';
    case 'lot_deactivated':             return 'Parking deactivated';
    default:                            return type;
  }
}

module.exports = {
  getConfiguration,
  getConfigurationGrid,
  previewCapacityChange,
  applyCapacityChange,
  setSlotServiceState,
  previewPricingChange,
  applyPricingChange,
  applyHoursChange,
  applyAmenitiesChange,
  applyDetailsChange,
  getAuditLog,
  // exported for tests
  _internal: { computeImpactHash, capacityHashMaterial, validateDays, assertPrice, assertVersion },
};
