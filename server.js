// Fixed and cleaned server.js (Neon / PostgreSQL version)
// Key behaviours preserved from Mongo version:
// - HYBRID SLOT MODEL (slots created only on first booking).
// - OPTION B: Active 'bookings' and archive to 'booking_history' on exit.
// - No 'is_booked'/'status' field on 'slots' (status inferred from 'bookings').
// - Global error handler, consistent status codes.

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(express.json());
app.use(cors({ origin: '*' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Force JSON content-type for all responses
app.use((req, res, next) => {
  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', 'application/json');
  }
  next();
});

// ====== NEON POSTGRES CONNECTION (NO .env) ======
const pool = new Pool({
  connectionString:
    'postgresql://neondb_owner:npg_5x4ADLWqziOR@ep-billowing-unit-adv73ayu-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
});

// Helper: safe int cast
function toInt(id) {
  const num = Number(id);
  return Number.isInteger(num) ? num : null;
}

/* ────────────────────────────────────────────────
   USER APP ENDPOINTS
──────────────────────────────────────────────── */

// User Registration Endpoint
app.post('/api/users/register', async (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  try {
    const existing = await pool.query(
      'SELECT * FROM users WHERE phone=$1 LIMIT 1',
      [phone]
    );

    if (existing.rows.length > 0) {
      return res
        .status(200)
        .json({ message: 'User already exists', user: existing.rows[0] });
    }

    const now = new Date();
    const result = await pool.query(
      `INSERT INTO users (phone, name, created_at, updated_at)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [phone, name || 'User', now, now]
    );

    return res
      .status(201)
      .json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (error) {
    console.error('Error registering user:', error);
    // Unique constraint on phone
    if (error && error.code === '23505') {
      return res.status(400).json({ message: 'Phone already registered' });
    }
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// User Login Endpoint
app.post('/api/users/login', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE phone=$1 LIMIT 1',
      [phone]
    );
    if (!result.rows.length) {
      return res
        .status(404)
        .json({ message: 'User not found. Please register.' });
    }
    return res.status(200).json({ message: 'Login successful', user: result.rows[0] });
  } catch (error) {
    console.error('Error logging in user:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get User Profile
app.get('/api/users/profile/:phone', async (req, res) => {
  try {
    const { phone } = req.params || {};
    if (!phone) return res.status(400).json({ message: 'phone is required' });

    const result = await pool.query(
      'SELECT * FROM users WHERE phone=$1 LIMIT 1',
      [phone]
    );
    if (!result.rows.length) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get User Bookings (Active + History)
app.get('/api/users/bookings/:phone', async (req, res) => {
  try {
    const { phone } = req.params || {};
    if (!phone) return res.status(400).json({ message: 'phone is required' });

    // Active bookings
    const activeResult = await pool.query(
      `SELECT b.*, p.name AS location
       FROM bookings b
       LEFT JOIN parking_areas p ON p.id = b.parking_id
       WHERE b.phone=$1`,
      [phone]
    );

    // Historical bookings
    const historyResult = await pool.query(
      `SELECT h.*, p.name AS location
       FROM booking_history h
       LEFT JOIN parking_areas p ON p.id = h.parking_id
       WHERE h.phone=$1`,
      [phone]
    );

    const activeBookings = activeResult.rows.map(b => ({
      ...b,
      status: 'active',  // inferred like original
    }));

    const historicalBookings = historyResult.rows.map(h => ({
      ...h,
      status: 'completed',
    }));

    const allBookings = [...activeBookings, ...historicalBookings];

    // Match original behaviour: sort combined by entry_time descending
    allBookings.sort((a, b) => {
      const aTime = a.entry_time ? new Date(a.entry_time).getTime() : 0;
      const bTime = b.entry_time ? new Date(b.entry_time).getTime() : 0;
      return bTime - aTime;
    });

    return res.status(200).json(allBookings);
  } catch (error) {
    console.error('Error fetching user bookings:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get All Users (admin)
app.get('/api/users/all', async (req, res) => {
  try {
    const users = await pool.query('SELECT * FROM users');
    return res.status(200).json(users.rows);
  } catch (error) {
    console.error('Error fetching all users:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* ────────────────────────────────────────────────
   PARKING AREAS (USER + OWNER)
──────────────────────────────────────────────── */

// Get All Parking Areas
app.get('/api/parking_areas', async (req, res) => {
  try {
    const areas = await pool.query('SELECT * FROM parking_areas');
    const withLocation = areas.rows.map(a => ({
      ...a,
      location: { lat: a.lat, lng: a.lng }, // mimic Mongo { location: { lat, lng } }
    }));
    return res.status(200).json(withLocation);
  } catch (error) {
    console.error('Error fetching parking areas:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get Parking Area Details by ID for User App
app.get('/api/parking_areas/:id', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid parking area ID' });

    const result = await pool.query(
      'SELECT * FROM parking_areas WHERE id=$1',
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: 'Parking area not found' });
    }

    const area = result.rows[0];
    const response = {
      ...area,
      location: { lat: area.lat, lng: area.lng },
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching parking area details:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get All Slots for a Parking Area for User App (Hybrid Logic)
app.get('/api/parking_areas/:id/slots', async (req, res) => {
  try {
    const parking_id = toInt(req.params.id);
    if (!parking_id) {
      return res.status(400).json({ message: 'Invalid parking area ID' });
    }

    const { vehicle_type } = req.query || {};
    if (!vehicle_type || !['car', 'bike'].includes(vehicle_type.toLowerCase())) {
      return res.status(400).json({ message: 'Valid vehicle_type query param required' });
    }
    const vType = vehicle_type.toLowerCase();

    const areaResult = await pool.query(
      'SELECT * FROM parking_areas WHERE id=$1',
      [parking_id]
    );
    if (!areaResult.rows.length) {
      return res.status(404).json({ message: 'Parking area not found' });
    }

    const parkingArea = areaResult.rows[0];
    const totalSlots =
      vType === 'car'
        ? parkingArea.total_car_slots
        : parkingArea.total_bike_slots;

    if (!totalSlots || totalSlots === 0) {
      return res.status(200).json([]);
    }

    const activeBookings = await pool.query(
      'SELECT slot_number FROM bookings WHERE parking_id=$1 AND vehicle_type=$2',
      [parking_id, vType]
    );

    const bookedSlotNumbers = new Set(
      activeBookings.rows.map(b => b.slot_number)
    );

    const allSlots = Array.from({ length: totalSlots }, (_, i) => {
      const slot_number = i + 1;
      const is_booked = bookedSlotNumbers.has(slot_number);
      return {
        parking_id,
        slot_number,
        vehicle_type: vType,
        is_booked,
        status: is_booked ? 'booked' : 'available',
      };
    });

    return res.status(200).json(allSlots);
  } catch (error) {
    console.error('Error fetching slots:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* ────────────────────────────────────────────────
   BOOKING HELPER (Used by user & owner)
──────────────────────────────────────────────── */

async function processBooking(req, res) {
  try {
    const {
      parking_id,
      slot_number,
      vehicle_type,
      number_plate,
      entry_time,
      phone,
    } = req.body || {};

    const parkingId = toInt(parking_id);

    if (!parkingId || !slot_number || !vehicle_type) {
      return res
        .status(400)
        .json({ message: 'parking_id, slot_number and vehicle_type are required' });
    }

    const vType = vehicle_type.toLowerCase();

    // Fetch parking area
    const areaResult = await pool.query(
      'SELECT * FROM parking_areas WHERE id=$1',
      [parkingId]
    );
    if (!areaResult.rows.length) {
      return res.status(404).json({ message: 'Parking area not found' });
    }

    const parkingArea = areaResult.rows[0];
    const totalSlotsKey = vType === 'car' ? 'total_car_slots' : 'total_bike_slots';
    const totalSlots = parkingArea[totalSlotsKey];

    if (slot_number > totalSlots || slot_number <= 0) {
      return res
        .status(400)
        .json({ message: 'Invalid slot_number for the parking area' });
    }

    // Check for active booking
    const existingActiveBooking = await pool.query(
      `SELECT * FROM bookings
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3`,
      [parkingId, slot_number, vType]
    );
    if (existingActiveBooking.rows.length > 0) {
      return res
        .status(400)
        .json({ message: `Slot ${slot_number} is already actively booked.` });
    }

    // HYBRID MODEL: Ensure slot exists
    const slotResult = await pool.query(
      `INSERT INTO slots (parking_id, slot_number, vehicle_type, last_booked_at, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW(),NOW())
       ON CONFLICT (parking_id,vehicle_type,slot_number)
       DO UPDATE SET last_booked_at=NOW(), updated_at=NOW()
       RETURNING id`,
      [parkingId, slot_number, vType]
    );
    const slotId = slotResult.rows[0].id;

    const now = new Date();
    const entryTime = entry_time ? new Date(entry_time) : now;

    // Create booking
    const bookingResult = await pool.query(
      `INSERT INTO bookings
       (parking_id, slot_id, slot_number, vehicle_type, number_plate, phone,
        entry_time, exit_time, payment_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        parkingId,
        slotId,
        slot_number,
        vType,
        number_plate || '',
        phone || '',
        entryTime,
        null,
        '',
        now,
        now,
      ]
    );

    // Update parking area counts
    if (vType === 'car') {
      await pool.query(
        `UPDATE parking_areas
         SET available_car_slots = available_car_slots - 1,
             booked_car_slots = booked_car_slots + 1
         WHERE id=$1`,
        [parkingId]
      );
    } else {
      await pool.query(
        `UPDATE parking_areas
         SET available_bike_slots = available_bike_slots - 1,
             booked_bike_slots = booked_bike_slots + 1
         WHERE id=$1`,
        [parkingId]
      );
    }

    return res.status(200).json({
      message: 'Slot booked',
      booking_id: bookingResult.rows[0].id,
      slot_number,
    });
  } catch (error) {
    console.error('Error booking slot:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
}

// Book a Slot for User App
app.post('/api/bookings', processBooking);

/* ────────────────────────────────────────────────
   OWNER APP ENDPOINTS
──────────────────────────────────────────────── */

// Get All Parking Area Owners
app.get('/api/owner/all', async (req, res) => {
  try {
    // Exclude password like Mongo projection
    const owners = await pool.query(
      'SELECT id, phone, parking_area_name, created_at, updated_at FROM register_login'
    );
    return res.status(200).json(owners.rows);
  } catch (error) {
    console.error('Error fetching all owners:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Register Parking Area Owner
app.post('/api/owner/register', async (req, res) => {
  const { phone, parking_area_name, password } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  try {
    const existing = await pool.query(
      'SELECT * FROM register_login WHERE phone=$1 LIMIT 1',
      [phone]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const now = new Date();
    const ownerResult = await pool.query(
      `INSERT INTO register_login (phone, parking_area_name, password, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, phone, parking_area_name, created_at, updated_at`,
      [phone, parking_area_name, password, now, now]
    );

    return res.status(201).json({
      message: 'Registered successfully',
      owner: ownerResult.rows[0], // password not included
    });
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(400).json({ message: 'Phone already registered' });
    }
    console.error('Error registering owner:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Login Parking Area Owner
app.post('/api/owner/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone) return res.status(400).json({ message: 'phone is required' });

    let result;
    if (password) {
      result = await pool.query(
        'SELECT * FROM register_login WHERE phone=$1 AND password=$2 LIMIT 1',
        [phone, password]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM register_login WHERE phone=$1 LIMIT 1',
        [phone]
      );
    }

    if (!result.rows.length) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const owner = result.rows[0];
    return res.status(200).json({
      message: 'Login successful',
      phone: owner.phone,
      parking_area_name: owner.parking_area_name,
    });
  } catch (error) {
    console.error('Error logging in owner:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Update or Create Parking Area (Hybrid Model)
app.post('/api/owner/parking_areas', async (req, res) => {
  const {
    name: ownerPhone,
    parking_area_name,
    location,
    total_car_slots,
    total_bike_slots,
  } = req.body || {};

  if (!ownerPhone) {
    return res.status(400).json({ message: 'owner phone (name) is required' });
  }
  if (!parking_area_name) {
    return res.status(400).json({ message: 'parking_area_name is required' });
  }

  try {
    // Check existing parking area by name
    const existingAreaResult = await pool.query(
      'SELECT * FROM parking_areas WHERE name=$1 LIMIT 1',
      [parking_area_name]
    );
    const existingArea = existingAreaResult.rows[0];

    const newTotalCarSlots =
      typeof total_car_slots === 'number'
        ? total_car_slots
        : existingArea
        ? existingArea.total_car_slots
        : 0;

    const newTotalBikeSlots =
      typeof total_bike_slots === 'number'
        ? total_bike_slots
        : existingArea
        ? existingArea.total_bike_slots
        : 0;

    // Update owner's linked parking area name
    await pool.query(
      `UPDATE register_login
       SET parking_area_name=$1, updated_at=NOW()
       WHERE phone=$2`,
      [parking_area_name, ownerPhone]
    );

    const lat = location?.lat ?? null;
    const lng = location?.lng ?? null;

    if (existingArea) {
      // Update existing area
      const currentCarSlots = existingArea.total_car_slots;
      const currentBikeSlots = existingArea.total_bike_slots;
      const carSlotsChanged = newTotalCarSlots !== currentCarSlots;
      const bikeSlotsChanged = newTotalBikeSlots !== currentBikeSlots;

      const setParts = [
        'lat=$1',
        'lng=$2',
        'total_car_slots=$3',
        'total_bike_slots=$4',
        'updated_at=NOW()',
      ];
      const values = [lat, lng, newTotalCarSlots, newTotalBikeSlots];

      // Reset available/booked counts only if changed
      if (carSlotsChanged) {
        setParts.push('available_car_slots=$5', 'booked_car_slots=0');
        values.push(newTotalCarSlots);
      }
      if (bikeSlotsChanged) {
        // careful index: if carSlotsChanged used $5, bike uses $6; else uses $5
        const bikeIndex = carSlotsChanged ? 6 : 5;
        setParts.push(`available_bike_slots=$${bikeIndex}`, 'booked_bike_slots=0');
        values.push(newTotalBikeSlots);
      }

      // Where clause uses last param
      const whereIndex = values.length + 1;
      const sql = `UPDATE parking_areas SET ${setParts.join(
        ', '
      )} WHERE name=$${whereIndex}`;

      values.push(parking_area_name);

      await pool.query(sql, values);

      // HYBRID LOGIC: Reset slots/bookings if capacity changed
      if (carSlotsChanged || bikeSlotsChanged) {
        const parkingId = existingArea.id;

        await pool.query('DELETE FROM slots WHERE parking_id=$1', [parkingId]);
        await pool.query('DELETE FROM bookings WHERE parking_id=$1', [parkingId]);

        return res.status(200).json({
          message:
            'Parking area updated. All slots/bookings reset due to capacity change (Hybrid Model).',
        });
      }

      return res
        .status(200)
        .json({ message: 'Parking area updated successfully' });
    } else {
      // Create new parking area
      const now = new Date();
      const result = await pool.query(
        `INSERT INTO parking_areas
         (name, lat, lng,
          total_car_slots, available_car_slots, booked_car_slots,
          total_bike_slots, available_bike_slots, booked_bike_slots,
          created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          parking_area_name,
          lat,
          lng,
          newTotalCarSlots,
          newTotalCarSlots,
          0,
          newTotalBikeSlots,
          newTotalBikeSlots,
          0,
          now,
          now,
        ]
      );

      return res.status(201).json({
        message: 'Parking area created (Hybrid Model - no initial slots created)',
        id: result.rows[0].id,
      });
    }
  } catch (error) {
    console.error('Error processing parking area:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get Parking Areas for Owner
app.get('/api/owner/parking_areas', async (req, res) => {
  try {
    const areas = await pool.query('SELECT * FROM parking_areas');
    const withLocation = areas.rows.map(a => ({
      ...a,
      location: { lat: a.lat, lng: a.lng },
    }));
    return res.status(200).json(withLocation);
  } catch (error) {
    console.error('Error fetching parking areas:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get Slots for a Parking Area for Owner (same hybrid logic)
app.get('/api/owner/parking_areas/:id/slots', async (req, res) => {
  try {
    const parking_id = toInt(req.params.id);
    if (!parking_id) {
      return res.status(400).json({ message: 'Invalid parking area ID' });
    }

    const { vehicle_type } = req.query || {};
    if (!vehicle_type || !['car', 'bike'].includes(vehicle_type.toLowerCase())) {
      return res.status(400).json({ message: 'Valid vehicle_type query param required' });
    }
    const vType = vehicle_type.toLowerCase();

    const areaResult = await pool.query(
      'SELECT * FROM parking_areas WHERE id=$1',
      [parking_id]
    );
    if (!areaResult.rows.length) {
      return res.status(404).json({ message: 'Parking area not found' });
    }

    const parkingArea = areaResult.rows[0];
    const totalSlots =
      vType === 'car'
        ? parkingArea.total_car_slots
        : parkingArea.total_bike_slots;

    if (!totalSlots || totalSlots === 0) {
      return res.status(200).json([]);
    }

    const activeBookings = await pool.query(
      'SELECT slot_number FROM bookings WHERE parking_id=$1 AND vehicle_type=$2',
      [parking_id, vType]
    );

    const bookedSlotNumbers = new Set(
      activeBookings.rows.map(b => b.slot_number)
    );

    const allSlots = Array.from({ length: totalSlots }, (_, i) => {
      const slot_number = i + 1;
      const is_booked = bookedSlotNumbers.has(slot_number);
      return {
        parking_id,
        slot_number,
        vehicle_type: vType,
        is_booked,
        status: is_booked ? 'booked' : 'available',
      };
    });

    return res.status(200).json(allSlots);
  } catch (error) {
    console.error('Error fetching slots:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Book a Slot for Owner (Uses processBooking helper)
app.post('/api/owner/bookings', processBooking);

// Get Booking Details for Owner (active booking for slot)
app.get('/api/owner/bookings', async (req, res) => {
  try {
    const { parking_id, slot_number, vehicle_type } = req.query || {};
    if (!parking_id || !slot_number || !vehicle_type) {
      return res.status(400).json({
        message: 'parking_id, slot_number, and vehicle_type query params required',
      });
    }

    const parkingId = toInt(parking_id);
    const numSlot = parseInt(slot_number, 10);
    const vType = vehicle_type.toLowerCase();

    if (!parkingId || isNaN(numSlot)) {
      return res.status(400).json({ message: 'Invalid id(s)/slot_number' });
    }

    const result = await pool.query(
      `SELECT * FROM bookings
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3
       LIMIT 1`,
      [parkingId, numSlot, vType]
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ message: 'No active booking found for this slot.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching active booking:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Complete a Booking and Free the Slot for Owner (Option B Logic)
app.post('/api/owner/bookings/complete', async (req, res) => {
  try {
    const {
      booking_id,
      parking_id,
      vehicle_type,
      exit_time,
      amount,
      payment_id,
    } = req.body || {};

    if (!booking_id || !parking_id || !vehicle_type) {
      return res
        .status(400)
        .json({ message: 'booking_id, parking_id, and vehicle_type are required' });
    }

    const bookingId = toInt(booking_id);
    const parkingId = toInt(parking_id);
    const vType = vehicle_type.toLowerCase();

    if (!bookingId || !parkingId) {
      return res.status(400).json({ message: 'Invalid id(s)' });
    }

    // Fetch the active booking
    const activeResult = await pool.query(
      `SELECT * FROM bookings
       WHERE id=$1 AND parking_id=$2 AND vehicle_type=$3
       LIMIT 1`,
      [bookingId, parkingId, vType]
    );

    if (!activeResult.rows.length) {
      return res
        .status(404)
        .json({ message: 'No active booking found with this ID' });
    }

    const activeBooking = activeResult.rows[0];
    const finalExitTime = exit_time ? new Date(exit_time) : new Date();
    const finalAmount = amount || 0;

    // Archive to booking_history
    await pool.query(
      `INSERT INTO booking_history
       (booking_id, parking_id, slot_id, slot_number, phone,
        vehicle_type, number_plate, entry_time, exit_time,
        payment_id, amount, archived_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        activeBooking.id,
        activeBooking.parking_id,
        activeBooking.slot_id,
        activeBooking.slot_number,
        activeBooking.phone,
        activeBooking.vehicle_type,
        activeBooking.number_plate,
        activeBooking.entry_time,
        finalExitTime,
        payment_id || '',
        finalAmount,
        new Date(),
      ]
    );

    // Delete from active bookings
    await pool.query('DELETE FROM bookings WHERE id=$1', [bookingId]);

    // Update parking area counts
    if (vType === 'car') {
      await pool.query(
        `UPDATE parking_areas
         SET available_car_slots = available_car_slots + 1,
             booked_car_slots = booked_car_slots - 1
         WHERE id=$1`,
        [parkingId]
      );
    } else {
      await pool.query(
        `UPDATE parking_areas
         SET available_bike_slots = available_bike_slots + 1,
             booked_bike_slots = booked_bike_slots - 1
         WHERE id=$1`,
        [parkingId]
      );
    }

    return res.status(200).json({
      message: 'Booking completed and slot freed',
      amount: finalAmount,
    });
  } catch (error) {
    console.error('Error completing booking:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* ────────────────────────────────────────────────
   GLOBAL ERROR HANDLER
──────────────────────────────────────────────── */

app.use((err, req, res, next) => {
  console.error('GLOBAL ERROR:', err && (err.stack || err.message || err));
  if (!res.headersSent) {
    res
      .status(500)
      .json({ message: 'Internal Server Error', error: err.message || String(err) });
  }
});

/* ────────────────────────────────────────────────
   START SERVER
──────────────────────────────────────────────── */

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
