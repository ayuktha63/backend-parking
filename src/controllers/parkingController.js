'use strict';

/**
 * Parking discovery HTTP layer.
 */

const parkingService = require('../services/parkingService');
const { asyncHandler } = require('./authController');

/** Maps query-string filter params onto the service's filter object. */
function filtersFrom(q) {
  return {
    maxPricePaise: q.max_price_paise,
    minRating: q.min_rating,
    availableOnly: q.available_only === true,
    openNow: q.open_now === true,
    open24x7: q.open_24_7 === true,
    amenities: q.amenities,
  };
}

/** GET /api/v1/parking */
const search = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;

  const result = await parkingService.search({
    lat: q.lat,
    lng: q.lng,
    radiusMetres: q.radius_m,
    query: q.q,
    vehicleType: q.vehicle_type,
    startAt: q.start_at,
    durationMinutes: q.duration_minutes,
    filters: filtersFrom(q),
    // Distance sorting is meaningless without a position; fall back rather than
    // returning an arbitrary order the user would read as "nearest".
    sort: q.sort === 'distance' && (q.lat === undefined || q.lng === undefined)
      ? 'popularity'
      : q.sort,
    limit: q.limit,
    offset: q.offset,
  });

  res.json({ data: result.items, meta: { window: result.window, page: result.page } });
});

/**
 * GET /api/v1/parking/bounds
 *
 * Powers "Search this area". Returns markers for the current viewport.
 */
const byBounds = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;

  const result = await parkingService.search({
    bounds: { north: q.north, south: q.south, east: q.east, west: q.west },
    // Still supplied when available, so each marker can show a distance.
    lat: q.lat,
    lng: q.lng,
    vehicleType: q.vehicle_type,
    startAt: q.start_at,
    durationMinutes: q.duration_minutes,
    filters: filtersFrom(q),
    sort: q.lat !== undefined && q.lng !== undefined ? 'distance' : 'popularity',
    limit: q.limit,
    offset: 0,
  });

  res.json({
    data: result.items,
    meta: {
      window: result.window,
      bounds: { north: q.north, south: q.south, east: q.east, west: q.west },
      count: result.items.length,
      truncated: result.page.has_more,
    },
  });
});

/** GET /api/v1/parking/suggest */
const suggest = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const result = await parkingService.suggest({
    query: q.q,
    lat: q.lat,
    lng: q.lng,
    limit: q.limit,
  });
  res.json({ data: result });
});

/** GET /api/v1/parking/:id */
const detail = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const parking = await parkingService.getDetail({
    id: req.params.id,
    vehicleType: q.vehicle_type,
    startAt: q.start_at,
    durationMinutes: q.duration_minutes,
    lat: q.lat,
    lng: q.lng,
  });
  res.json({ data: parking });
});

/**
 * GET /api/v1/parking/:id/pricing
 *
 * The endpoint the customer app never called, which is why every screen displayed a
 * hardcoded "₹30/hr" unrelated to what was actually charged.
 */
const pricing = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const quote = await parkingService.getPricing({
    id: req.params.id,
    vehicleType: q.vehicle_type,
    startAt: q.start_at,
    durationMinutes: q.duration_minutes,
    slotCount: q.slot_count,
  });
  res.json({ data: quote });
});

/**
 * GET /api/v1/parking/:id/availability
 *
 * The single availability source for both apps. `held_by_you` is resolved from the
 * caller's identity when they are signed in, so a held slot is distinguishable from
 * one the caller is holding themselves.
 */
const availability = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const result = await parkingService.getAvailability({
    id: req.params.id,
    vehicleType: q.vehicle_type,
    startAt: q.start_at,
    durationMinutes: q.duration_minutes,
    forUserId: req.auth?.role === 'customer' ? req.auth.id : null,
  });
  res.json({ data: result });
});

module.exports = { search, byBounds, suggest, detail, pricing, availability };
