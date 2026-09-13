#!/usr/bin/env node
/**
 * DEVELOPMENT SEED — realistic parking inventory for a local database.
 *
 * WHY THIS EXISTS
 *   The development database had one geocoded parking area and 46 rows named
 *   "Contract Test Lot" left behind by the contract suite, none of which had
 *   coordinates. A map-first product cannot be built, evaluated or demonstrated
 *   against a single marker: clustering, the availability comparison column,
 *   the limited/full/closed treatments and the empty state are all invisible.
 *
 * WHAT IT IS NOT
 *   It is not display data, and nothing here reaches the UI directly. Every row
 *   is ordinary database content that the API reads and computes over exactly as
 *   it does in production:
 *
 *     - availability is NOT written anywhere. The discovery query derives it
 *       live by counting active slots that have no overlapping booking and no
 *       live hold (see parkingRepository.js). To make a lot read "Filling up"
 *       or "Full" this script inserts REAL CONFIRMED BOOKINGS against real
 *       slots, and the server draws its own conclusions.
 *     - prices are base rates; the pricing engine still calculates every quote.
 *     - open/closed comes from parking_opening_hours evaluated in the lot's own
 *       local time, so the lot that is shut is shut because of its hours.
 *     - ratings are left NULL. No review rows are invented, so the UI hides the
 *       rating everywhere — which is the honest result and exercises the
 *       "no rating" path that real lots will hit.
 *
 *   In short: this seeds the DATABASE, not the interface. The app still shows
 *   only what the backend tells it.
 *
 * SAFETY
 *   Refuses to run against a database whose name does not look like a local
 *   development or test database. Idempotent: re-running replaces the lots it
 *   owns (identified by the `seed:dev` marker in `instructions`) and leaves
 *   everything else — including parking area 1 — untouched.
 *
 * USAGE
 *   npm run seed:dev
 */

'use strict';

const { Pool } = require('pg');

const MARKER = 'seed:dev';

/**
 * Real localities in Bengaluru with their actual coordinates. Spread across
 * roughly 12km so the map has something to cluster at low zoom and to separate
 * as the user zooms in.
 */
const LOTS = [
  {
    name: 'Brigade Road Parkade', locality: 'Brigade Road', lat: 12.9719, lng: 77.6074,
    address: '12 Brigade Road', car: 24, bike: 12, carPaise: 6000, bikePaise: 2500,
    amenities: ['covered', 'cctv', 'security', 'lift'], open24: true,
    occupyCar: 6, occupyBike: 2,
  },
  {
    name: 'Indiranagar Metro Parking', locality: 'Indiranagar', lat: 12.9784, lng: 77.6408,
    address: '100 Feet Road', car: 40, bike: 30, carPaise: 4000, bikePaise: 1500,
    amenities: ['cctv', 'accessible', 'washroom'], open24: true,
    occupyCar: 34, occupyBike: 12,
  },
  {
    name: 'Koramangala Forum Basement', locality: 'Koramangala', lat: 12.9345, lng: 77.6110,
    address: '21 Hosur Road', car: 60, bike: 40, carPaise: 5000, bikePaise: 2000,
    amenities: ['covered', 'cctv', 'security', 'ev_charging', 'lift', 'washroom'],
    open24: false, hours: { opensAt: '07:00', closesAt: '23:00' },
    occupyCar: 60, occupyBike: 18,
  },
  {
    name: 'MG Road Surface Lot', locality: 'MG Road', lat: 12.9756, lng: 77.6068,
    address: 'Near Trinity Circle', car: 18, bike: 10, carPaise: 7000, bikePaise: 3000,
    amenities: ['security'], open24: true,
    occupyCar: 3, occupyBike: 0,
  },
  {
    name: 'Jayanagar 4th Block', locality: 'Jayanagar', lat: 12.9250, lng: 77.5838,
    address: '11th Main Road', car: 30, bike: 25, carPaise: 3000, bikePaise: 1200,
    amenities: ['cctv', 'washroom'], open24: true,
    occupyCar: 11, occupyBike: 6,
  },
  {
    name: 'Whitefield Tech Park', locality: 'Whitefield', lat: 12.9698, lng: 77.7500,
    address: 'ITPL Main Road', car: 80, bike: 50, carPaise: 3500, bikePaise: 1500,
    amenities: ['covered', 'cctv', 'security', 'ev_charging', 'valet', 'lift'],
    open24: true, occupyCar: 22, occupyBike: 9,
  },
  {
    name: 'Malleshwaram Station Yard', locality: 'Malleshwaram', lat: 13.0035, lng: 77.5712,
    address: '8th Cross', car: 16, bike: 20, carPaise: 2500, bikePaise: 1000,
    amenities: ['accessible'], open24: false,
    // Deliberately shut right now, so the closed treatment is reachable in dev.
    hours: { opensAt: '06:00', closesAt: '09:00' },
    occupyCar: 0, occupyBike: 0,
  },
  {
    name: 'HSR Layout Sector 2', locality: 'HSR Layout', lat: 12.9116, lng: 77.6389,
    address: '27th Main Road', car: 28, bike: 22, carPaise: 3500, bikePaise: 1400,
    amenities: ['cctv', 'car_wash', 'washroom'], open24: true,
    occupyCar: 25, occupyBike: 20,
  },
  {
    name: 'Cubbon Park Gate', locality: 'Cubbon Park', lat: 12.9763, lng: 77.5929,
    address: 'Kasturba Road', car: 22, bike: 18, carPaise: 4500, bikePaise: 1800,
    amenities: ['security', 'accessible'], open24: true,
    occupyCar: 8, occupyBike: 3,
  },
];

function assertLocalDatabase(connectionString) {
  // Parsed by hand rather than with `new URL`, which throws outright on the
  // unix-socket form this project uses locally
  // (postgresql://parqx@/parqx_test?host=/tmp/parqx-pg/sock — empty host plus a
  // path). Splitting on "/" is no better: it returns "sock&port=55432", the tail
  // of the query string, instead of the database name.
  const match = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/?]*)\/([^?]+)(?:\?(.*))?$/i.exec(
    connectionString,
  );
  if (!match) {
    throw new Error('Refusing to seed: could not parse DATABASE_URL.');
  }

  const [, hostPart, rawName, query = ''] = match;
  const name = decodeURIComponent(rawName);
  const socketHost = /(?:^|&)host=([^&]*)/.exec(query)?.[1] ?? '';
  const host = decodeURIComponent(hostPart || socketHost);

  const nameLooksDisposable = /test|dev|local/i.test(name);
  const hostIsLocal =
    host === '' || host === 'localhost' || host === '127.0.0.1' || host.startsWith('/');

  if (!nameLooksDisposable || !hostIsLocal) {
    throw new Error(
      `Refusing to seed: database "${name}" on host "${host || '(local socket)'}" ` +
        'does not look like a local dev/test database.\n' +
        'This script inserts and deletes rows and must never touch a real one.',
    );
  }
}

function slotCodes(count, prefix) {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

async function main() {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://parqx@/parqx_test?host=/tmp/parqx-pg/sock&port=55432';

  assertLocalDatabase(connectionString);

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: owners } = await client.query(
      'SELECT id FROM owners ORDER BY id LIMIT 1',
    );
    if (owners.length === 0) throw new Error('No owner exists; sign an operator up first.');
    const ownerId = owners[0].id;

    const { rows: users } = await client.query('SELECT id, phone FROM users ORDER BY id LIMIT 1');
    if (users.length === 0) throw new Error('No user exists; sign a customer in first.');
    const occupant = users[0];

    // ── clear only what this script owns ─────────────────────────────────
    const { rows: previous } = await client.query(
      `SELECT id FROM parking_areas WHERE instructions = $1`,
      [MARKER],
    );
    const previousIds = previous.map((r) => r.id);
    if (previousIds.length > 0) {
      await client.query(`DELETE FROM bookings WHERE parking_id = ANY($1::bigint[])`, [previousIds]);
      await client.query(`DELETE FROM slot_holds WHERE parking_area_id = ANY($1::bigint[])`, [previousIds]);
      await client.query(`DELETE FROM parking_slots WHERE parking_area_id = ANY($1::bigint[])`, [previousIds]);
      await client.query(`DELETE FROM parking_amenities WHERE parking_area_id = ANY($1::bigint[])`, [previousIds]);
      await client.query(`DELETE FROM parking_opening_hours WHERE parking_area_id = ANY($1::bigint[])`, [previousIds]);
      await client.query(`DELETE FROM parking_areas WHERE id = ANY($1::bigint[])`, [previousIds]);
      console.log(`· removed ${previousIds.length} previously seeded lot(s)`);
    }

    let totalSlots = 0;
    let totalBookings = 0;

    for (const lot of LOTS) {
      const slug = lot.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      const { rows: inserted } = await client.query(
        `INSERT INTO parking_areas
           (owner_id, name, slug, lat, lng, address_line, locality, city, state,
            total_car_slots, available_car_slots, booked_car_slots,
            total_bike_slots, available_bike_slots, booked_bike_slots,
            base_car_price_paise, base_bike_price_paise,
            is_active, is_open_24_7, instructions, rating_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Bengaluru','Karnataka',
                 $8,$8,0,$9,$9,0,$10,$11,TRUE,$12,$13,0)
         RETURNING id`,
        [
          ownerId, lot.name, slug, lot.lat, lot.lng, lot.address, lot.locality,
          lot.car, lot.bike, lot.carPaise, lot.bikePaise, lot.open24 === true, MARKER,
        ],
      );
      const areaId = inserted[0].id;

      // ── slots ─────────────────────────────────────────────────────────
      const carCodes = slotCodes(lot.car, 'C');
      const bikeCodes = slotCodes(lot.bike, 'B');
      const createdSlots = { car: [], bike: [] };

      for (const [type, codes] of [['car', carCodes], ['bike', bikeCodes]]) {
        for (let i = 0; i < codes.length; i += 1) {
          const { rows } = await client.query(
            `INSERT INTO parking_slots
               (parking_area_id, code, vehicle_type, slot_class, row_label,
                position, slot_number, is_active)
             VALUES ($1,$2,$3,'standard',$4,$5,$6,TRUE)
             RETURNING id`,
            [areaId, codes[i], type, codes[i][0], i + 1, i + 1],
          );
          createdSlots[type].push(rows[0].id);
          totalSlots += 1;
        }
      }

      // ── amenities ─────────────────────────────────────────────────────
      for (const code of lot.amenities) {
        await client.query(
          `INSERT INTO parking_amenities (parking_area_id, amenity_code)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [areaId, code],
        );
      }

      // ── opening hours ─────────────────────────────────────────────────
      // Only for lots that are not 24/7. A lot with no rows is treated as
      // always open by OPEN_NOW_EXPR, which is why the 24/7 ones get none.
      if (lot.hours) {
        for (let day = 0; day < 7; day += 1) {
          await client.query(
            `INSERT INTO parking_opening_hours
               (parking_area_id, day_of_week, opens_at, closes_at, closes_next_day)
             VALUES ($1,$2,$3,$4,FALSE)`,
            [areaId, day, lot.hours.opensAt, lot.hours.closesAt],
          );
        }
      }

      // ── occupancy, as real bookings ───────────────────────────────────
      //
      // The server counts a slot unavailable when a booking overlaps the
      // requested window. Writing an "available_slots" number directly would be
      // a lie the API would immediately contradict, so occupancy is created the
      // only way the system recognises: by booking slots.
      const now = new Date();
      const entry = new Date(now.getTime() - 30 * 60 * 1000);
      const exit = new Date(now.getTime() + 4 * 60 * 60 * 1000);

      // `source` is constrained to the values the product actually produces
      // (chk_bookings_source). These stand in for people who drove up and paid
      // at the gate, which is what 'walk_in' means — not a fictional channel.
      for (const [type, count] of [['car', lot.occupyCar], ['bike', lot.occupyBike]]) {
        for (let i = 0; i < count; i += 1) {
          const slotId = createdSlots[type][i];
          if (!slotId) break;
          const paise = type === 'car' ? lot.carPaise : lot.bikePaise;
          await client.query(
            `INSERT INTO bookings
               (parking_id, slot_number, vehicle_type, slot_id, number_plate, phone,
                entry_time, expected_exit_time, duration_minutes, payment_id,
                amount_legacy_rupees, is_verified_legacy, status, user_id,
                parking_slot_id, booking_code, amount_paise, currency,
                pricing_snapshot, checkout_snapshot, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,270,'',0,FALSE,'CONFIRMED',$9,$4,$10,$11,'INR',
                     '{}'::jsonb,'{}'::jsonb,'walk_in')`,
            [
              areaId, i + 1, type, slotId,
              'KA01AB' + String(1000 + i).slice(-4),
              occupant.phone, entry, exit, occupant.id,
              `SEED${areaId}${type[0].toUpperCase()}${i + 1}`,
              paise * 4,
            ],
          );
          totalBookings += 1;
        }
      }

      console.log(
        `✓ ${lot.name.padEnd(30)} ${String(lot.car).padStart(3)} car / ` +
          `${String(lot.bike).padStart(2)} bike · ` +
          `${lot.occupyCar} + ${lot.occupyBike} occupied` +
          (lot.hours ? ` · ${lot.hours.opensAt}–${lot.hours.closesAt}` : ' · 24/7'),
      );
    }

    await client.query('COMMIT');
    console.log(
      `\nSeeded ${LOTS.length} parking areas, ${totalSlots} slots, ` +
        `${totalBookings} occupying bookings.`,
    );
    console.log(
      'Availability, pricing and open/closed are all still computed by the API ' +
        'from these rows — nothing was written to a display field.',
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nSeed failed:', error.message);
  process.exit(1);
});
