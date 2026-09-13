'use strict';

/**
 * Operator HTTP layer.
 *
 * Every handler passes `req.auth.id` as the owner. There is no code path by which
 * an owner id from the request body or the URL reaches a service — which is the
 * whole of the operator authorisation model, expressed in one convention.
 */

const operatorService = require('../services/operatorService');
const parkingConfigService = require('../services/parkingConfigService');
const parkingPhotoService = require('../services/parkingPhotoService');
const { asyncHandler } = require('./authController');

/** GET /api/v1/owner/dashboard */
const dashboard = asyncHandler(async (req, res) => {
  const data = await operatorService.getDashboard({
    ownerId: req.auth.id,
    parkingAreaId: req.validatedQuery.parking_area_id ?? null,
  });
  res.json({ data });
});

/** GET /api/v1/owner/arrivals */
const arrivals = asyncHandler(async (req, res) => {
  const data = await operatorService.getArrivals({
    ownerId: req.auth.id,
    parkingAreaId: req.validatedQuery.parking_area_id ?? null,
    hoursAhead: req.validatedQuery.hours_ahead,
  });
  res.json({ data });
});

/**
 * POST /api/v1/owner/lookup
 *
 * The arrival desk. POST rather than GET so a booking code never lands in a server
 * access log or a browser history — it is the credential that admits a car.
 */
const lookup = asyncHandler(async (req, res) => {
  const result = await operatorService.lookupBooking({
    ownerId: req.auth.id,
    code: req.body.code,
  });
  res.json({ data: result.booking, meta: { verification: result.verification } });
});

/** POST /api/v1/owner/lookup/plate — for a driver who has lost their code. */
const lookupByPlate = asyncHandler(async (req, res) => {
  const result = await operatorService.lookupByPlate({
    ownerId: req.auth.id,
    plate: req.body.number_plate,
  });
  res.json({ data: result.matches, meta: { count: result.count } });
});

/**
 * POST /api/v1/owner/bookings/:bookingId/check-in
 *
 * 200 whether or not this call changed anything: a booking that was already checked
 * in is a state to report, not an error. Two operators tapping at once must not
 * give the second one a red screen.
 */
const checkIn = asyncHandler(async (req, res) => {
  const result = await operatorService.checkInBooking({
    ownerId: req.auth.id,
    bookingId: req.params.bookingId,
  });

  res.json({
    data: result.booking,
    meta: {
      changed: result.changed,
      already_checked_in: result.already_checked_in,
      was_late_override: result.was_late_override,
    },
  });
});

/** GET /api/v1/owner/bookings/:bookingId/check-out-preview */
const checkOutPreview = asyncHandler(async (req, res) => {
  const data = await operatorService.checkOutPreview({
    ownerId: req.auth.id,
    bookingId: req.params.bookingId,
  });
  res.json({ data });
});

/** POST /api/v1/owner/bookings/:bookingId/check-out */
const checkOut = asyncHandler(async (req, res) => {
  const result = await operatorService.checkOutBooking({
    ownerId: req.auth.id,
    bookingId: req.params.bookingId,
  });

  res.json({
    data: result.booking,
    meta: {
      changed: result.changed,
      already_completed: result.already_completed,
      settlement: result.settlement,
    },
  });
});

/** POST /api/v1/owner/bookings/:bookingId/no-show */
const markNoShow = asyncHandler(async (req, res) => {
  const result = await operatorService.markNoShow({
    ownerId: req.auth.id,
    bookingId: req.params.bookingId,
    reason: req.body?.reason ?? null,
  });
  res.json({ data: result.booking, meta: { changed: result.changed } });
});

/** GET /api/v1/owner/grid */
const grid = asyncHandler(async (req, res) => {
  const data = await operatorService.getLiveGrid({
    ownerId: req.auth.id,
    parkingAreaId: req.validatedQuery.parking_area_id ?? null,
    vehicleType: req.validatedQuery.vehicle_type ?? null,
  });
  res.json({ data });
});

/** GET /api/v1/owner/slots/:slotId */
const slotDetail = asyncHandler(async (req, res) => {
  const data = await operatorService.getSlotDetail({
    ownerId: req.auth.id,
    slotId: req.params.slotId,
  });
  res.json({ data });
});

/**
 * POST /api/v1/owner/slots/:slotId/service
 *
 * Refuses while the slot has upcoming reservations — see the service. Closing a
 * slot someone has paid for is the capacity-deletion failure one space at a time.
 */
const setSlotService = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.setSlotServiceState({
    ownerId: req.auth.id,
    slotId: req.params.slotId,
    isActive: req.body.is_active,
    reason: req.body.reason ?? null,
  });
  res.json({ data });
});

/** GET /api/v1/owner/bookings */
const bookings = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const result = await operatorService.listBookings({
    ownerId: req.auth.id,
    parkingAreaId: q.parking_area_id ?? null,
    filter: q.filter,
    search: q.q ?? null,
    limit: q.limit,
    offset: q.offset,
  });

  res.json({
    data: result.items,
    meta: { counts: result.counts, page: result.page, filter: result.filter },
  });
});

/** GET /api/v1/owner/bookings/:bookingId */
const bookingDetail = asyncHandler(async (req, res) => {
  const data = await operatorService.getBookingDetail({
    ownerId: req.auth.id,
    bookingId: req.params.bookingId,
  });
  res.json({ data });
});

/* ── configuration ─────────────────────────────────────────────────────────── */

/** GET /api/v1/owner/config */
const config = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.getConfiguration({
    ownerId: req.auth.id,
    parkingAreaId: req.validatedQuery.parking_area_id ?? null,
  });
  res.json({ data });
});

/**
 * GET /api/v1/owner/config/grid
 *
 * The configuration view of the layout — every slot and what constrains changing
 * it — as opposed to /owner/grid, which shows what is happening right now.
 */
const configGrid = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.getConfigurationGrid({
    ownerId: req.auth.id,
    parkingAreaId: req.validatedQuery.parking_area_id ?? null,
    vehicleType: req.validatedQuery.vehicle_type ?? null,
  });
  res.json({ data });
});

/**
 * POST /api/v1/owner/config/capacity/preview
 *
 * Computes the impact without applying it. POST because it is a computation over a
 * body, not an addressable resource — and because the result is state-dependent
 * enough that caching it would be actively wrong.
 */
const capacityPreview = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.previewCapacityChange({
    ownerId: req.auth.id,
    parkingAreaId: req.body.parking_area_id ?? null,
    vehicleType: req.body.vehicle_type,
    target: req.body.target,
  });
  res.json({ data });
});

/**
 * POST /api/v1/owner/config/capacity
 *
 * Applies a reviewed change. The `impact_hash` from the preview is recomputed
 * server-side inside a locked transaction; a mismatch means the world moved and the
 * change is refused with IMPACT_HASH_MISMATCH.
 */
const capacityApply = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.applyCapacityChange({
    ownerId: req.auth.id,
    parkingAreaId: req.body.parking_area_id ?? null,
    vehicleType: req.body.vehicle_type,
    target: req.body.target,
    impactHash: req.body.impact_hash,
  });
  res.json({ data: data.configuration, meta: { applied: true, change: {
    from: data.from, to: data.to,
    closed: data.closed, reopened: data.reopened, created: data.created,
  } } });
});

/** POST /api/v1/owner/config/pricing/preview */
const pricingPreview = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.previewPricingChange({
    ownerId: req.auth.id,
    parkingAreaId: req.body.parking_area_id ?? null,
    carPaise: req.body.car_paise ?? null,
    bikePaise: req.body.bike_paise ?? null,
  });
  res.json({ data });
});

/** POST /api/v1/owner/config/pricing */
const pricingApply = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.applyPricingChange({
    ownerId: req.auth.id,
    parkingAreaId: req.body.parking_area_id ?? null,
    carPaise: req.body.car_paise ?? null,
    bikePaise: req.body.bike_paise ?? null,
    version: req.body.version,
  });
  res.json({ data: data.configuration, meta: { applied: true } });
});

/** POST /api/v1/owner/config/hours */
const hoursApply = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.applyHoursChange({
    ownerId: req.auth.id,
    parkingAreaId: req.body.parking_area_id ?? null,
    isOpen24x7: req.body.is_open_24_7,
    days: req.body.days,
    version: req.body.version,
  });
  res.json({ data: data.configuration, meta: { applied: true } });
});

/** POST /api/v1/owner/config/amenities */
const amenitiesApply = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.applyAmenitiesChange({
    ownerId: req.auth.id,
    parkingAreaId: req.body.parking_area_id ?? null,
    codes: req.body.codes,
    version: req.body.version,
  });
  res.json({ data: data.configuration, meta: { applied: true } });
});

/** POST /api/v1/owner/config/details */
const detailsApply = asyncHandler(async (req, res) => {
  const { parking_area_id: parkingAreaId, version, ...rest } = req.body;

  const data = await parkingConfigService.applyDetailsChange({
    ownerId: req.auth.id,
    parkingAreaId: parkingAreaId ?? null,
    patch: {
      name: rest.name,
      description: rest.description,
      instructions: rest.instructions,
      addressLine: rest.address_line,
      locality: rest.locality,
      city: rest.city,
      state: rest.state,
      postalCode: rest.postal_code,
      landmark: rest.landmark,
      contactPhone: rest.contact_phone,
    },
    version,
  });
  res.json({ data: data.configuration, meta: { applied: true } });
});

/** GET /api/v1/owner/config/audit */
const configAudit = asyncHandler(async (req, res) => {
  const data = await parkingConfigService.getAuditLog({
    ownerId: req.auth.id,
    parkingAreaId: req.validatedQuery.parking_area_id ?? null,
    limit: req.validatedQuery.limit,
  });
  res.json({ data });
});

/** GET /api/v1/owner/profile */
const profile = asyncHandler(async (req, res) => {
  const data = await operatorService.getProfile({ ownerId: req.auth.id });
  res.json({ data });
});


/* ── photographs ───────────────────────────────────────────────────────────── */

async function photos(req, res) {
  const result = await parkingPhotoService.list({
    ownerId: req.auth.id,
    parkingAreaId: req.query.parking_area_id ?? null,
  });
  res.json({ data: result });
}

/**
 * The body arrives as raw bytes (see `express.raw` on this route), so there is
 * no parsed field to read a caption from — it rides in the query string.
 */
async function photoAdd(req, res) {
  const photo = await parkingPhotoService.add({
    ownerId: req.auth.id,
    parkingAreaId: req.query.parking_area_id ?? null,
    buffer: req.body,
    contentType: (req.get('content-type') || '').split(';')[0].trim(),
    caption: req.query.caption ?? null,
  });
  res.status(201).json({ data: photo });
}

async function photoSetCover(req, res) {
  const result = await parkingPhotoService.setCover({
    ownerId: req.auth.id,
    parkingAreaId: req.query.parking_area_id ?? null,
    photoId: Number(req.params.photoId),
  });
  res.json({ data: result });
}

async function photoDelete(req, res) {
  const result = await parkingPhotoService.destroy({
    ownerId: req.auth.id,
    parkingAreaId: req.query.parking_area_id ?? null,
    photoId: Number(req.params.photoId),
  });
  res.json({ data: result });
}

module.exports = {
  photos,
  photoAdd,
  photoSetCover,
  photoDelete,
  dashboard,
  arrivals,
  lookup,
  lookupByPlate,
  checkIn,
  checkOutPreview,
  checkOut,
  markNoShow,
  grid,
  slotDetail,
  setSlotService,
  bookings,
  bookingDetail,
  profile,
  // configuration
  config,
  configGrid,
  capacityPreview,
  capacityApply,
  pricingPreview,
  pricingApply,
  hoursApply,
  amenitiesApply,
  detailsApply,
  configAudit,
};
