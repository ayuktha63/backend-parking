'use strict';

/**
 * Parking discovery.
 *
 * Shapes repository rows into the API contract the clients consume.
 *
 * The serialisation rule, which is a product rule rather than a technical one:
 * **a field the database does not have is omitted, never invented.** The old app
 * read `popularity_score`, `photo_url`, `image`, `address`, `city` and `state` from
 * responses that never contained them, so every card showed the same stock photo,
 * "Popular Parking" sorted by a constant zero, and the location label rendered as
 * the literal string ", ".
 *
 * `rating` is null when a lot has no reviews. `cover_photo_url` is null when it has
 * no photos. The client hides those rows rather than filling them in.
 */

const { config } = require('../config');
const photos = require('../utils/publicUrl');
const parkingRepository = require('../repositories/parkingRepository');
const slotRepository = require('../repositories/slotRepository');
const pricingService = require('./pricingService');
const time = require('../utils/time');
const money = require('../utils/money');
const { notFound, badRequest } = require('../utils/errors');

/** Resolves the window a discovery request applies to. */
function resolveWindow({ startAt, durationMinutes }) {
  const start = time.parseInstant(startAt) || time.nowUtc();
  const duration = Number(durationMinutes) || config.booking.defaultDurationMinutes;
  return { start, end: time.addMinutes(start, duration), duration };
}

/**
 * Availability bucket used by cards and map markers.
 * Four states, one definition, shared by both apps.
 */
function availabilityState({ available, total, isOpenNow }) {
  if (!isOpenNow) return 'closed';
  if (total === 0) return 'unavailable';
  if (available === 0) return 'full';
  if (available / total <= config.pricing.limitedAvailabilityRatio) return 'limited';
  return 'available';
}

/** List/marker representation. */
function serializeListItem(row, { vehicleType, hourlyPricePaise }) {
  const total = row.slots_total ?? 0;
  const available = row.slots_available ?? 0;
  const isOpenNow = row.is_open_now === true;

  const distanceMetres =
    row.distance_metres === null || row.distance_metres === undefined
      ? null
      : Math.round(Number(row.distance_metres));

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,

    location: {
      lat: row.lat === null ? null : Number(row.lat),
      lng: row.lng === null ? null : Number(row.lng),
      address_line: row.address_line ?? null,
      locality: row.locality ?? null,
      city: row.city ?? null,
      landmark: row.landmark ?? null,
    },

    // Null when the caller gave no location — the client shows no distance rather
    // than a fabricated one.
    distance_metres: distanceMetres,
    eta_minutes: distanceMetres === null ? null : estimateEtaMinutes(distanceMetres),

    availability: {
      vehicle_type: vehicleType,
      total_slots: total,
      available_slots: available,
      state: availabilityState({ available, total, isOpenNow }),
    },

    // Hourly rate for the requested window, from the pricing engine — not a
    // hardcoded "₹30/hr" string.
    price: {
      hourly_paise: hourlyPricePaise,
      hourly_display: money.formatPaise(hourlyPricePaise),
      currency: config.payments.currency,
    },

    // Null when the lot has no reviews. The UI hides the row.
    rating: row.rating_avg === null ? null : Number(row.rating_avg),
    rating_count: row.rating_count ?? 0,

    is_open_now: isOpenNow,
    is_open_24_7: row.is_open_24_7 === true,

    // Null when the lot has no photo. The UI renders a deterministic gradient
    // placeholder built from the lot's name, never a stock image of somewhere else.
    //
    // Absolutised: uploaded photos are STORED root-relative so a row stays
    // correct if the host changes, but a client's image loader has no base to
    // resolve against — `Image.network('/uploads/...')` simply fails. An
    // externally-hosted URL passes through untouched.
    cover_photo_url: photos.absolute(row.cover_photo_url) ?? null,

    amenities: Array.isArray(row.amenities) ? row.amenities : [],
  };
}

/**
 * Straight-line distance over an assumed average city speed.
 *
 * Labelled as an estimate in the UI. The old code used the same approach but
 * presented the output as a definite travel time.
 */
const ETA_AVERAGE_SPEED_KMH = 24;

function estimateEtaMinutes(distanceMetres) {
  const km = distanceMetres / 1000;
  // Straight-line distance understates real road distance; a 1.3 factor is the
  // usual urban approximation and keeps the estimate from reading optimistically.
  const roadKm = km * 1.3;
  return Math.max(1, Math.round((roadKm / ETA_AVERAGE_SPEED_KMH) * 60));
}

/**
 * Discovery search.
 *
 * Prices every result through the pricing engine in one pass. That is N+1 by shape,
 * but N is page-sized (20) and each call is a couple of counting queries; correctness
 * of the displayed price matters more here than shaving queries, and the alternative
 * is showing a price that differs from the one charged.
 */
async function search(params) {
  const { start, end, duration } = resolveWindow(params);
  const vehicleType = params.vehicleType || 'car';

  const { rows, hasMore } = await parkingRepository.search({
    ...params,
    vehicleType,
    startAt: start,
    endAt: end,
  });

  const items = await Promise.all(
    rows.map(async (row) => {
      const quote = await pricingService.quote({
        parkingArea: row,
        vehicleType,
        startAt: start,
        durationMinutes: duration,
      });
      return serializeListItem(row, {
        vehicleType,
        hourlyPricePaise: quote.hourly_price_paise,
      });
    })
  );

  return {
    items,
    window: {
      starts_at: time.toIso(start),
      ends_at: time.toIso(end),
      duration_minutes: duration,
      vehicle_type: vehicleType,
    },
    page: {
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
      has_more: hasMore,
    },
  };
}

/** Full detail for the parking page. */
async function getDetail({ id, vehicleType = 'car', startAt, durationMinutes, lat, lng }) {
  const { start, end, duration } = resolveWindow({ startAt, durationMinutes });

  const row = await parkingRepository.findById(id, {
    vehicleType,
    startAt: start,
    endAt: end,
    lat,
    lng,
  });

  if (!row) throw notFound('That parking area is not available', 'PARKING_NOT_FOUND');

  const quote = await pricingService.quote({
    parkingArea: row,
    vehicleType,
    startAt: start,
    durationMinutes: duration,
  });

  const base = serializeListItem(row, {
    vehicleType,
    hourlyPricePaise: quote.hourly_price_paise,
  });

  return {
    ...base,
    description: row.description ?? null,
    instructions: row.instructions ?? null,
    contact_phone: row.contact_phone ?? null,

    location: {
      ...base.location,
      postal_code: row.postal_code ?? null,
    },

    photos: (row.photos || []).map((p) => ({
      id: p.id,
      url: photos.absolute(p.url),
      caption: p.caption ?? null,
      is_cover: p.is_cover === true,
    })),

    amenities: (row.amenities || []).map((a) => ({
      code: a.code,
      label: a.label,
      icon: a.icon ?? null,
    })),

    // Empty array means "no hours recorded", which the client renders as
    // "Hours not listed" rather than inventing 24/7.
    opening_hours: (row.opening_hours || []).map((h) => ({
      day_of_week: h.day_of_week,
      opens_at: h.opens_at,
      closes_at: h.closes_at,
      closes_next_day: h.closes_next_day === true,
    })),

    // Full quote, so the detail page shows the same number the review screen will.
    pricing: quote,

    capacity: {
      car: { total_slots: row.total_car_slots ?? 0 },
      bike: { total_slots: row.total_bike_slots ?? 0 },
    },

    max_duration_minutes: row.max_duration_minutes ?? config.booking.maxDurationMinutes,
  };
}

/** Price for an exact window, used by the Slot & Time screen as the user adjusts it. */
async function getPricing({ id, vehicleType, startAt, durationMinutes, slotCount = 1 }) {
  const area = await parkingRepository.findRawById(id);
  if (!area || area.is_active === false) {
    throw notFound('That parking area is not available', 'PARKING_NOT_FOUND');
  }

  const { start, duration } = resolveWindow({ startAt, durationMinutes });

  const maxAdvance = time.addMinutes(time.nowUtc(), config.booking.maxAdvanceDays * 24 * 60);
  if (time.isAfter(start, maxAdvance)) {
    throw badRequest(
      `Bookings can be made up to ${config.booking.maxAdvanceDays} days ahead`,
      undefined,
      'BOOKING_TOO_FAR_AHEAD'
    );
  }

  return pricingService.quote({
    parkingArea: area,
    vehicleType,
    startAt: start,
    durationMinutes: duration,
    slotCount,
  });
}

/**
 * Slot layout with live state.
 *
 * The single availability source. Both apps call this; there is no operator variant
 * with different rules.
 */
async function getAvailability({ id, vehicleType, startAt, durationMinutes, forUserId = null }) {
  const area = await parkingRepository.findRawById(id);
  if (!area || area.is_active === false) {
    throw notFound('That parking area is not available', 'PARKING_NOT_FOUND');
  }

  const { start, end, duration } = resolveWindow({ startAt, durationMinutes });

  // eslint-disable-next-line global-require
  const configRepository = require('../repositories/configRepository');

  const [slots, summary, openness] = await Promise.all([
    slotRepository.getLayout({
      parkingAreaId: id,
      vehicleType,
      startAt: start,
      endAt: end,
      forUserId,
    }),
    slotRepository.getAvailabilitySummary({
      parkingAreaId: id,
      vehicleType,
      startAt: start,
      endAt: end,
    }),
    configRepository.isOpenForWindow({ parkingAreaId: id, startAt: start, endAt: end }),
  ]);

  // Grouped into rows so the client renders a layout rather than a flat grid.
  const rowMap = new Map();
  for (const slot of slots) {
    if (!rowMap.has(slot.row_label)) rowMap.set(slot.row_label, []);
    rowMap.get(slot.row_label).push({
      id: slot.id,
      code: slot.code,
      slot_number: slot.slot_number,
      position: slot.position,
      slot_class: slot.slot_class,
      status: slot.status,
      held_by_you: slot.held_by_you === true,
      hold_expires_at: slot.hold_expires_at ? time.toIso(slot.hold_expires_at) : null,
      closed_reason: slot.closed_reason ?? null,
    });
  }

  return {
    parking_area_id: id,
    vehicle_type: vehicleType,
    window: {
      starts_at: time.toIso(start),
      ends_at: time.toIso(end),
      duration_minutes: duration,
      // Whether the lot is actually open then. A slot picker that lets someone
      // choose a slot for a Sunday the operator has closed, and only refuses at
      // hold time, is a picker that wastes the customer's time.
      is_open: openness.open === true,
    },
    summary,
    // Ordered A, B, C… with the entrance before the first row, so the client draws
    // the layout without inventing structure.
    rows: [...rowMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, rowSlots]) => ({
        label,
        slots: rowSlots.sort((a, b) => a.position - b.position),
      })),
    legend: ['available', 'held', 'booked', 'closed'],
  };
}

/** Search-as-you-type suggestions. */
async function suggest({ query, lat, lng, limit }) {
  const { areas, localities } = await parkingRepository.suggest({ query, lat, lng, limit });

  return {
    parking: areas.map((a) => ({
      type: 'parking',
      id: a.id,
      name: a.name,
      subtitle: [a.locality, a.city].filter(Boolean).join(', ') || null,
      location: { lat: a.lat === null ? null : Number(a.lat), lng: a.lng === null ? null : Number(a.lng) },
      distance_metres:
        a.distance_metres === null || a.distance_metres === undefined
          ? null
          : Math.round(Number(a.distance_metres)),
    })),
    localities: localities.map((l) => ({
      type: 'locality',
      name: l.locality,
      subtitle: l.city ?? null,
      parking_count: l.parking_count,
    })),
  };
}

module.exports = {
  search,
  getDetail,
  getPricing,
  getAvailability,
  suggest,
  serializeListItem,
  availabilityState,
  resolveWindow,
};
