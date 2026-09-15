'use strict';

/**
 * Parking areas — discovery.
 *
 * All distance, search and filtering happens in SQL. The old customer app
 * downloaded every parking area in the system on every Home entry and then computed
 * Haversine distances, sorted, and filtered in Dart — which does not scale past a
 * demo, and meant "search" was a client-side `name.contains()` over whatever had
 * already been downloaded.
 *
 * Distance uses the spherical law of cosines, which is accurate enough at city
 * scale and needs no PostGIS. A bounding box narrows candidates first so the
 * trigonometry only runs on rows that could plausibly match.
 */

const db = require('../db');

/** Rows shared by list and detail responses. */
const LIST_COLUMNS = `
  pa.id,
  pa.name,
  pa.slug,
  pa.lat,
  pa.lng,
  pa.address_line,
  pa.locality,
  pa.city,
  pa.landmark,
  pa.total_car_slots,
  pa.total_bike_slots,
  pa.base_car_price_paise,
  pa.base_bike_price_paise,
  pa.rating_avg,
  pa.rating_count,
  pa.popularity_score,
  pa.is_active,
  pa.is_open_24_7,
  pa.timezone_offset_minutes,
  pa.max_duration_minutes
`;

/**
 * Great-circle distance in metres, as a SQL expression.
 * `$lat`/`$lng` are placeholder indices supplied by the caller.
 */
function distanceExpr(latParam, lngParam) {
  return `
    (6371000 * acos(
      LEAST(1.0, GREATEST(-1.0,
        cos(radians($${latParam})) * cos(radians(pa.lat)) *
        cos(radians(pa.lng) - radians($${lngParam})) +
        sin(radians($${latParam})) * sin(radians(pa.lat))
      ))
    ))`;
}

/**
 * Live availability per lot, for the requested window and vehicle type.
 *
 * This is the ONE definition of availability. The old system had three: a drifting
 * `available_*_slots` counter the customer app read, a recomputation from slot
 * statuses the operator app did, and a third time-aware derivation in the customer
 * slots endpoint. They disagreed with each other.
 */
const AVAILABILITY_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE ps.is_active)::int AS total_slots,
      COUNT(*) FILTER (
        WHERE ps.is_active AND NOT EXISTS (
          SELECT 1 FROM bookings b
           WHERE b.parking_slot_id = ps.id
             AND b.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
             AND tstzrange(b.entry_time, b.expected_exit_time, '[)')
                 && tstzrange($WINDOW_START::timestamptz, $WINDOW_END::timestamptz, '[)')
        ) AND NOT EXISTS (
          SELECT 1 FROM slot_holds h
           WHERE h.parking_slot_id = ps.id
             AND h.hold_expires_at > NOW()
             AND h.consumed_at IS NULL AND h.released_at IS NULL
        )
      )::int AS available_slots
    FROM parking_slots ps
    WHERE ps.parking_area_id = pa.id
      AND ps.vehicle_type = $VEHICLE_TYPE
  ) avail ON TRUE
`;

/**
 * Whether the lot is open at a given instant, evaluated in the lot's own local time.
 * A lot with no opening-hours rows is treated as always open.
 */
const OPEN_NOW_EXPR = `
  (pa.is_open_24_7 OR NOT EXISTS (
     SELECT 1 FROM parking_opening_hours oh WHERE oh.parking_area_id = pa.id
   ) OR EXISTS (
     SELECT 1 FROM parking_opening_hours oh
      WHERE oh.parking_area_id = pa.id
        AND oh.day_of_week = EXTRACT(DOW FROM (NOW() + make_interval(mins => pa.timezone_offset_minutes)))::int
        AND (
          (NOT oh.closes_next_day AND
             (NOW() + make_interval(mins => pa.timezone_offset_minutes))::time BETWEEN oh.opens_at AND oh.closes_at)
          OR
          (oh.closes_next_day AND
             ((NOW() + make_interval(mins => pa.timezone_offset_minutes))::time >= oh.opens_at
              OR (NOW() + make_interval(mins => pa.timezone_offset_minutes))::time <= oh.closes_at))
        )
   ))`;

/**
 * Searches parking areas.
 *
 * @param {object} params
 * @param {number} [params.lat] required for distance and radius
 * @param {number} [params.lng]
 * @param {number} [params.radiusMetres]
 * @param {{north:number,south:number,east:number,west:number}} [params.bounds] map viewport
 * @param {string} [params.query] free text over name, locality, city, landmark
 * @param {'car'|'bike'} params.vehicleType
 * @param {Date} params.startAt window the availability figure applies to
 * @param {Date} params.endAt
 * @param {object} [params.filters]
 * @param {'distance'|'price'|'rating'|'availability'} [params.sort]
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 */
async function search({
  lat,
  lng,
  radiusMetres,
  bounds,
  query,
  vehicleType,
  startAt,
  endAt,
  filters = {},
  sort = 'distance',
  limit = 20,
  offset = 0,
  client = null,
}) {
  const params = [];
  const push = (v) => {
    params.push(v);
    return params.length;
  };

  // Fixed leading parameters, referenced by the availability lateral join.
  const pVehicle = push(vehicleType);
  const pStart = push(startAt);
  const pEnd = push(endAt);

  const availabilityJoin = AVAILABILITY_JOIN.replace(/\$VEHICLE_TYPE/g, `$${pVehicle}`)
    .replace(/\$WINDOW_START/g, `$${pStart}`)
    .replace(/\$WINDOW_END/g, `$${pEnd}`);

  const where = ['pa.is_active'];
  let distanceSelect = 'NULL::double precision AS distance_metres';
  let distanceOrder = null;

  // ── location ──────────────────────────────────────────────────────────
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const pLat = push(lat);
    const pLng = push(lng);
    const expr = distanceExpr(pLat, pLng);
    distanceSelect = `${expr} AS distance_metres`;
    distanceOrder = expr;

    where.push('pa.lat IS NOT NULL AND pa.lng IS NOT NULL');

    if (Number.isFinite(radiusMetres) && radiusMetres > 0) {
      // Cheap bounding box first so the index can be used, then the exact circle.
      const degLat = radiusMetres / 111320;
      const degLng = radiusMetres / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
      where.push(`pa.lat BETWEEN $${push(lat - degLat)} AND $${push(lat + degLat)}`);
      where.push(`pa.lng BETWEEN $${push(lng - degLng)} AND $${push(lng + degLng)}`);
      where.push(`${expr} <= $${push(radiusMetres)}`);
    }
  }

  // ── map viewport ("search this area") ─────────────────────────────────
  if (bounds) {
    where.push(`pa.lat BETWEEN $${push(bounds.south)} AND $${push(bounds.north)}`);
    where.push(`pa.lng BETWEEN $${push(bounds.west)} AND $${push(bounds.east)}`);
  }

  // ── text search ───────────────────────────────────────────────────────
  if (query && query.trim()) {
    const q = query.trim();
    const pQ = push(`%${q}%`);
    const pTs = push(q);
    where.push(`(
      pa.name ILIKE $${pQ}
      OR pa.locality ILIKE $${pQ}
      OR pa.city ILIKE $${pQ}
      OR pa.landmark ILIKE $${pQ}
      OR pa.address_line ILIKE $${pQ}
      OR to_tsvector('simple',
           coalesce(pa.name,'') || ' ' || coalesce(pa.locality,'') || ' ' ||
           coalesce(pa.city,'') || ' ' || coalesce(pa.landmark,''))
         @@ plainto_tsquery('simple', $${pTs})
    )`);
  }

  // ── filters ───────────────────────────────────────────────────────────
  if (filters.openNow) where.push(OPEN_NOW_EXPR);
  if (filters.open24x7) where.push('pa.is_open_24_7');

  if (Number.isFinite(filters.maxPricePaise)) {
    const col = vehicleType === 'bike' ? 'pa.base_bike_price_paise' : 'pa.base_car_price_paise';
    where.push(`COALESCE(${col}, 0) <= $${push(filters.maxPricePaise)}`);
  }

  if (Number.isFinite(filters.minRating)) {
    where.push(`pa.rating_avg IS NOT NULL AND pa.rating_avg >= $${push(filters.minRating)}`);
  }

  if (filters.availableOnly) {
    where.push('COALESCE(avail.available_slots, 0) > 0');
  }

  if (Array.isArray(filters.amenities) && filters.amenities.length > 0) {
    // Must have ALL requested amenities, not any.
    const pAmen = push(filters.amenities);
    where.push(`(
      SELECT COUNT(DISTINCT amenity_code) FROM parking_amenities am
       WHERE am.parking_area_id = pa.id AND am.amenity_code = ANY($${pAmen})
    ) = array_length($${pAmen}, 1)`);
  }

  // ── ordering ──────────────────────────────────────────────────────────
  const priceCol = vehicleType === 'bike' ? 'pa.base_bike_price_paise' : 'pa.base_car_price_paise';
  let orderBy;
  switch (sort) {
    case 'price':
      orderBy = `COALESCE(${priceCol}, 2147483647) ASC, ${distanceOrder ?? 'pa.id'} ASC`;
      break;
    case 'rating':
      orderBy = `pa.rating_avg DESC NULLS LAST, pa.rating_count DESC, pa.id ASC`;
      break;
    case 'availability':
      orderBy = `COALESCE(avail.available_slots, 0) DESC, ${distanceOrder ?? 'pa.id'} ASC`;
      break;
    case 'popularity':
      orderBy = `pa.popularity_score DESC, pa.rating_avg DESC NULLS LAST, pa.id ASC`;
      break;
    case 'distance':
    default:
      orderBy = distanceOrder ? `${distanceOrder} ASC` : 'pa.popularity_score DESC, pa.id ASC';
  }

  const pLimit = push(limit + 1); // one extra row tells us whether more exist
  const pOffset = push(offset);

  const sql = `
    SELECT
      ${LIST_COLUMNS},
      ${distanceSelect},
      COALESCE(avail.total_slots, 0)     AS slots_total,
      COALESCE(avail.available_slots, 0) AS slots_available,
      ${OPEN_NOW_EXPR}                   AS is_open_now,
      (SELECT url FROM parking_photos ph
        WHERE ph.parking_area_id = pa.id
        ORDER BY ph.is_cover DESC, ph.sort_order ASC LIMIT 1) AS cover_photo_url,
      (SELECT COALESCE(array_agg(am.amenity_code ORDER BY am.amenity_code), '{}')
         FROM parking_amenities am WHERE am.parking_area_id = pa.id) AS amenities
    FROM parking_areas pa
    ${availabilityJoin}
    WHERE ${where.join('\n      AND ')}
    ORDER BY ${orderBy}
    LIMIT $${pLimit} OFFSET $${pOffset}
  `;

  const rows = await db.queryMany(sql, params, client);
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/** Full detail for one lot, including photos, amenities and opening hours. */
async function findById(id, { vehicleType, startAt, endAt, lat, lng, client = null } = {}) {
  const params = [vehicleType, startAt, endAt, id];
  const availabilityJoin = AVAILABILITY_JOIN.replace(/\$VEHICLE_TYPE/g, '$1')
    .replace(/\$WINDOW_START/g, '$2')
    .replace(/\$WINDOW_END/g, '$3');

  let distanceSelect = 'NULL::double precision AS distance_metres';
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    params.push(lat, lng);
    distanceSelect = `${distanceExpr(5, 6)} AS distance_metres`;
  }

  const area = await db.queryOne(
    `SELECT
       ${LIST_COLUMNS},
       pa.description,
       pa.instructions,
       pa.contact_phone,
       pa.postal_code,
       ${distanceSelect},
       COALESCE(avail.total_slots, 0)     AS slots_total,
       COALESCE(avail.available_slots, 0) AS slots_available,
       ${OPEN_NOW_EXPR}                   AS is_open_now
     FROM parking_areas pa
     ${availabilityJoin}
     WHERE pa.id = $4 AND pa.is_active`,
    params,
    client
  );

  if (!area) return null;

  const [photos, amenities, hours] = await Promise.all([
    db.queryMany(
      `SELECT id, url, caption, is_cover FROM parking_photos
        WHERE parking_area_id = $1 ORDER BY is_cover DESC, sort_order ASC`,
      [id],
      client
    ),
    db.queryMany(
      `SELECT a.code, a.label, a.icon FROM parking_amenities pam
         JOIN amenities a ON a.code = pam.amenity_code
        WHERE pam.parking_area_id = $1
        ORDER BY a.sort_order`,
      [id],
      client
    ),
    db.queryMany(
      `SELECT day_of_week, opens_at, closes_at, closes_next_day
         FROM parking_opening_hours WHERE parking_area_id = $1 ORDER BY day_of_week`,
      [id],
      client
    ),
  ]);

  return { ...area, photos, amenities, opening_hours: hours };
}

/** Minimal row for internal use — pricing, booking, ownership checks. */
async function findRawById(id, client = null) {
  return db.queryOne(`SELECT * FROM parking_areas WHERE id = $1`, [id], client);
}

/**
 * Search-as-you-type suggestions.
 *
 * Returns lots plus distinct localities, so typing "Kaz" offers both
 * "Kazhakuttom Parking" and the area "Kazhakuttom".
 */
async function suggest({ query, lat, lng, limit = 8, client = null }) {
  const q = `%${query.trim()}%`;
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);

  // `ASC` cannot be appended blindly — `popularity_score DESC ASC` is a syntax error.
  const orderBy = hasLocation
    ? `${distanceExpr(3, 4)} ASC`
    : 'pa.popularity_score DESC, pa.name ASC';

  const areas = await db.queryMany(
    `SELECT pa.id, pa.name, pa.locality, pa.city, pa.lat, pa.lng,
            ${hasLocation ? distanceExpr(3, 4) : 'NULL::double precision'} AS distance_metres
       FROM parking_areas pa
      WHERE pa.is_active AND (pa.name ILIKE $1 OR pa.locality ILIKE $1 OR pa.landmark ILIKE $1)
      ORDER BY ${orderBy}
      LIMIT $2`,
    hasLocation ? [q, limit, lat, lng] : [q, limit],
    client
  );

  const localities = await db.queryMany(
    `SELECT DISTINCT locality, city, COUNT(*)::int AS parking_count
       FROM parking_areas
      WHERE is_active AND locality IS NOT NULL AND locality ILIKE $1
      GROUP BY locality, city
      ORDER BY parking_count DESC
      LIMIT 4`,
    [q],
    client
  );

  return { areas, localities };
}

/** Bumps popularity when a booking completes, so "Popular" means something. */
async function incrementPopularity(parkingAreaId, delta = 1, client = null) {
  await db.query(
    `UPDATE parking_areas SET popularity_score = popularity_score + $2 WHERE id = $1`,
    [parkingAreaId, delta],
    client
  );
}

/** Recomputes the denormalised rating aggregate. */
async function refreshRating(parkingAreaId, client = null) {
  await db.query(
    `UPDATE parking_areas pa
        SET rating_avg = agg.avg_rating,
            rating_count = agg.cnt,
            updated_at = NOW()
       FROM (
         SELECT ROUND(AVG(rating)::numeric, 2) AS avg_rating, COUNT(*)::int AS cnt
           FROM parking_reviews WHERE parking_area_id = $1
       ) agg
      WHERE pa.id = $1`,
    [parkingAreaId],
    client
  );
}

module.exports = {
  search,
  findById,
  findRawById,
  suggest,
  incrementPopularity,
  refreshRating,
};
