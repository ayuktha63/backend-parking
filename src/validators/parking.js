'use strict';

const {
  z,
  id,
  vehicleType,
  instant,
  durationMinutes,
  latitude,
  longitude,
  searchQuery,
  limit,
} = require('./common');
const { config } = require('../config');

/** Repeated on every discovery endpoint: which window and which vehicle. */
const windowShape = {
  vehicle_type: vehicleType.default('car'),
  // Defaults to now when omitted — opening Home should not require picking a time.
  start_at: instant.optional(),
  duration_minutes: durationMinutes.default(config.booking.defaultDurationMinutes),
};

/** Caller's position. Optional: the app must work with location denied. */
const locationShape = {
  lat: latitude.optional(),
  lng: longitude.optional(),
};

const sortOptions = z
  .enum(['distance', 'price', 'rating', 'availability', 'popularity'])
  .default('distance');

/** Comma-separated amenity codes: `?amenities=covered,cctv` */
const amenityList = z
  .string()
  .trim()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )
  .pipe(z.array(z.string().max(32)).max(10))
  .optional();

const booleanFlag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')
  .optional();

/** GET /api/v1/parking */
const search = {
  query: z
    .object({
      ...windowShape,
      ...locationShape,
      q: searchQuery,
      radius_m: z.coerce
        .number()
        .int()
        .min(100)
        .max(config.booking ? 50000 : 50000)
        .optional(),
      sort: sortOptions,
      limit,
      offset: z.coerce.number().int().min(0).max(1000).default(0),

      // filters
      max_price_paise: z.coerce.number().int().min(0).optional(),
      min_rating: z.coerce.number().min(1).max(5).optional(),
      available_only: booleanFlag,
      open_now: booleanFlag,
      open_24_7: booleanFlag,
      amenities: amenityList,
    })
    .refine((v) => (v.radius_m === undefined) || (v.lat !== undefined && v.lng !== undefined), {
      message: 'radius_m requires lat and lng',
      path: ['radius_m'],
    })
    .refine((v) => (v.sort !== 'distance') || (v.lat !== undefined && v.lng !== undefined) || true, {
      // Sorting by distance without a location is allowed; the service falls back
      // to popularity rather than rejecting the request.
      message: '',
    }),
};

/**
 * GET /api/v1/parking/bounds — the map's "search this area".
 *
 * Bounds rather than a radius, because a rectangular viewport is what the user is
 * actually looking at.
 */
const bounds = {
  query: z
    .object({
      ...windowShape,
      ...locationShape,
      north: latitude,
      south: latitude,
      east: longitude,
      west: longitude,
      limit: z.coerce.number().int().min(1).max(200).default(100),
      available_only: booleanFlag,
      open_now: booleanFlag,
      max_price_paise: z.coerce.number().int().min(0).optional(),
      amenities: amenityList,
    })
    .refine((v) => v.north > v.south, {
      message: 'north must be greater than south',
      path: ['north'],
    })
    .refine(
      (v) => {
        // Guards against a request for the whole planet, which would return
        // everything and defeat the point of a viewport query.
        const latSpan = v.north - v.south;
        const lngSpan = Math.abs(v.east - v.west);
        return latSpan <= 2 && lngSpan <= 2;
      },
      { message: 'Zoom in to search a smaller area', path: ['north'] }
    ),
};

/** GET /api/v1/parking/suggest */
const suggest = {
  query: z.object({
    q: z.string().trim().min(1, 'Type something to search').max(80),
    ...locationShape,
    limit: z.coerce.number().int().min(1).max(20).default(8),
  }),
};

/** GET /api/v1/parking/:id */
const detail = {
  params: z.object({ id }),
  query: z.object({ ...windowShape, ...locationShape }),
};

/** GET /api/v1/parking/:id/pricing */
const pricing = {
  params: z.object({ id }),
  query: z.object({
    ...windowShape,
    slot_count: z.coerce.number().int().min(1).max(5).default(1),
  }),
};

/** GET /api/v1/parking/:id/availability */
const availability = {
  params: z.object({ id }),
  query: z.object(windowShape),
};

module.exports = { search, bounds, suggest, detail, pricing, availability };
