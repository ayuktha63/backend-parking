'use strict';

/**
 * Operator request schemas.
 *
 * Note what these schemas do NOT accept: an `owner_id` anywhere. The operator's
 * identity comes from the verified token and nothing else, so there is no request
 * shape through which one operator could address another's records.
 *
 * A `parking_area_id` IS accepted — an operator may hold several lots — but it is
 * a claim the service checks against ownership, never a fact it acts on.
 */

const { z, id, vehicleType } = require('./common');

/** Optional lot selector, shared by every screen. */
const areaQuery = z.object({
  parking_area_id: id.optional(),
});

const dashboard = { query: areaQuery };

const arrivals = {
  query: areaQuery.extend({
    // How far ahead the board reaches. Bounded so a client cannot ask for a year.
    hours_ahead: z.coerce.number().int().min(1).max(72).default(12),
  }),
};

/**
 * The code an operator types in.
 *
 * Tolerant on the way in — any case, spaces, a missing PQX- prefix — because it is
 * being read aloud at a barrier. `normaliseCode` in the service does the work; this
 * only bounds the length so a pathological string never reaches the database.
 */
const lookup = {
  body: z.object({
    code: z.string().trim().min(3, 'Enter a booking code').max(24, 'That is not a booking code'),
  }),
};

const lookupByPlate = {
  body: z.object({
    number_plate: z
      .string()
      .trim()
      .min(3, 'Enter a vehicle number')
      .max(16, 'That vehicle number looks too long'),
  }),
};

const bookingParam = { params: z.object({ bookingId: id }) };

const noShow = {
  params: z.object({ bookingId: id }),
  body: z.object({ reason: z.string().trim().max(300).optional() }).default({}),
};

const grid = {
  query: areaQuery.extend({
    vehicle_type: vehicleType.optional(),
  }),
};

const slotParam = { params: z.object({ slotId: id }) };

const slotService = {
  params: z.object({ slotId: id }),
  body: z.object({
    is_active: z.boolean(),
    reason: z.string().trim().max(200).optional(),
  }),
};

const bookings = {
  query: areaQuery.extend({
    filter: z.enum(['today', 'upcoming', 'active', 'completed', 'cancelled']).default('today'),
    q: z.string().trim().min(1).max(32).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
    offset: z.coerce.number().int().min(0).default(0),
  }),
};

/* ── configuration ─────────────────────────────────────────────────────────── */

/**
 * Optimistic-concurrency token, returned by the configuration read.
 *
 * Required on every settings write. Without it two operators editing the same lot
 * silently overwrite each other, and neither finds out.
 */
const configVersion = z
  .string()
  .trim()
  .min(10, 'Reload the settings before saving')
  .max(40);

const configQuery = { query: areaQuery.extend({ vehicle_type: vehicleType.optional() }) };

/**
 * Prices arrive in PAISE, as integers.
 *
 * Not rupees, and not a float. A decimal here is how ₹40.5 becomes 4050 in one
 * place and 40.5 in another — the exact class of bug that had this system holding
 * ₹24, charging ₹1 and displaying "$5.00" for one transaction.
 */
const pricePaise = z.coerce
  .number()
  .int('Price must be a whole number of paise')
  .min(0, 'Price cannot be negative')
  .max(1000000, 'Price looks wrong');

const capacityPreview = {
  body: z.object({
    parking_area_id: id.optional(),
    vehicle_type: vehicleType,
    target: z.coerce.number().int().min(0).max(2000),
  }),
};

const capacityApply = {
  body: z.object({
    parking_area_id: id.optional(),
    vehicle_type: vehicleType,
    target: z.coerce.number().int().min(0).max(2000),
    // The receipt from the preview. The server recomputes the impact and compares;
    // this is a claim about what was reviewed, never an input to the decision.
    impact_hash: z.string().trim().min(8).max(64),
  }),
};

const pricingPreview = {
  body: z.object({
    parking_area_id: id.optional(),
    car_paise: pricePaise.optional(),
    bike_paise: pricePaise.optional(),
  }),
};

const pricingApply = {
  body: z
    .object({
      parking_area_id: id.optional(),
      car_paise: pricePaise.optional(),
      bike_paise: pricePaise.optional(),
      version: configVersion,
    })
    .refine((b) => b.car_paise !== undefined || b.bike_paise !== undefined, {
      message: 'Set at least one price',
      path: ['car_paise'],
    }),
};

/** HH:MM, 24-hour. Wall clock in the lot's own zone — no timezone is invented. */
const clockTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM in 24-hour format');

const hoursApply = {
  body: z.object({
    parking_area_id: id.optional(),
    is_open_24_7: z.boolean(),
    // A day absent from this list is closed. That is the schema's meaning and the
    // UI states it, so an omitted day is never ambiguous.
    days: z
      .array(
        z.object({
          day_of_week: z.coerce.number().int().min(0).max(6),
          opens_at: clockTime,
          closes_at: clockTime,
          closes_next_day: z.boolean().default(false),
        })
      )
      .max(7, 'A week has seven days')
      .default([]),
    version: configVersion,
  }),
};

const amenitiesApply = {
  body: z.object({
    parking_area_id: id.optional(),
    // Checked against the `amenities` table, and enforced by the FK beneath it.
    codes: z.array(z.string().trim().toLowerCase().max(32)).max(20).default([]),
    version: configVersion,
  }),
};

const detailsApply = {
  body: z.object({
    parking_area_id: id.optional(),
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    instructions: z.string().trim().max(1000).optional(),
    address_line: z.string().trim().max(200).optional(),
    locality: z.string().trim().max(120).optional(),
    city: z.string().trim().max(120).optional(),
    state: z.string().trim().max(120).optional(),
    postal_code: z.string().trim().max(20).optional(),
    landmark: z.string().trim().max(160).optional(),
    contact_phone: z.string().trim().max(20).optional(),
    version: configVersion,
  }),
};

const auditQuery = {
  query: areaQuery.extend({
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
};

module.exports = {
  dashboard,
  arrivals,
  lookup,
  lookupByPlate,
  bookingParam,
  noShow,
  grid,
  slotParam,
  slotService,
  bookings,
  // configuration
  configQuery,
  capacityPreview,
  capacityApply,
  pricingPreview,
  pricingApply,
  hoursApply,
  amenitiesApply,
  detailsApply,
  auditQuery,
};
