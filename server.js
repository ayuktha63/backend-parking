// server.js
// Full updated server with buffer/verification/expiry logic
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const axios = require("axios");
const http = require('http');
const { Server } = require('socket.io');

const app = express();

app.use(express.json());
app.use(cors({ origin: '*' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.locals.otpStore = {};

// Force JSON content-type for all responses
app.use((req, res, next) => {
  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', 'application/json');
  }
  next();
});

/* =========================
   CONFIG & CONSTANTS
   ========================= */
const MSG91_AUTHKEY = "479720Apw1DjSN692aaeb5P1";         // <-- paste your MSG91 auth key
const WA_TEMPLATE_NAME = "transactional";
const WA_NAMESPACE = "5b1a5f70_3016_4451_8747_6fa69b8b564a";
const WA_INTEGRATED_NUMBER = "15558692939";

// Buffer logic - change to desired minutes
const BUFFER_MINUTES = 10;               // Slot reserved from entry_time - BUFFER to entry_time + BUFFER
const HOLD_SECONDS = 120;                // Hold duration for /api/holds (2 minutes)
const NOT_VERIFIED_CHECK_INTERVAL = 15000; // 15s check to expire unverified bookings
const HOLD_CLEANUP_INTERVAL = 5000;      // 5s cleanup for expired holds
const DB_CONNECTION_STRING =
  'postgresql://neondb_owner:npg_5x4ADLWqziOR@ep-lucky-water-adryg5p6-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

// Postgres pool
const pool = new Pool({
  connectionString: DB_CONNECTION_STRING,
});

// Helper: safe int cast
function toInt(id) {
  const num = Number(id);
  return Number.isInteger(num) ? num : null;
}

/* =========================
   OTP endpoints (unchanged)
   ========================= */
app.post("/api/auth/send-otp", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ message: "Phone is required" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  req.app.locals.otpStore[phone] = otp;

  try {
    const payload = {
      "integrated_number": WA_INTEGRATED_NUMBER,
      "content_type": "template",
      "payload": {
        "messaging_product": "whatsapp",
        "type": "template",
        "template": {
          "name": WA_TEMPLATE_NAME,
          "language": {
            "code": "en",
            "policy": "deterministic"
          },
          "namespace": WA_NAMESPACE,
          "to_and_components": [
            {
              "to": [`91${phone}`],
              "components": {
                "body_1": {
                  "type": "text",
                  "value": otp
                }
              }
            }
          ]
        }
      }
    };

    await axios.post(
      "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "authkey": MSG91_AUTHKEY
        }
      }
    );

    return res.status(200).json({
      message: "OTP sent via WhatsApp",
      debug_otp: otp // REMOVE IN PRODUCTION
    });

  } catch (error) {
    console.error("WhatsApp OTP ERROR:", error?.response?.data || error);
    return res.status(500).json({
      message: "Failed to send OTP",
      error: error?.response?.data || error
    });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ message: "Phone & OTP required" });

  const store = req.app.locals.otpStore;
  const realOtp = store[phone];
  if (!realOtp) return res.status(400).json({ message: "OTP expired or not found" });
  if (realOtp !== otp) return res.status(400).json({ message: "Invalid OTP" });

  delete store[phone];
  return res.status(200).json({ message: "OTP verified successfully" });
});

/* ============================
   USERS: register/login/profile
   ============================ */
app.post('/api/users/register', async (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  try {
    const existing = await pool.query('SELECT * FROM users WHERE phone=$1 LIMIT 1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(200).json({ message: 'User already exists', user: existing.rows[0] });
    }

    const now = new Date();
    const result = await pool.query(
      `INSERT INTO users (phone, name, created_at, updated_at)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [phone, name || 'User', now, now]
    );

    return res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (error) {
    console.error('Error registering user:', error);
    if (error && error.code === '23505') return res.status(400).json({ message: 'Phone already registered' });
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.post('/api/users/login', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE phone=$1 LIMIT 1', [phone]);
    if (!result.rows.length) {
      return res.status(404).json({ message: 'User not found. Please register.' });
    }
    return res.status(200).json({ message: 'Login successful', user: result.rows[0] });
  } catch (error) {
    console.error('Error logging in user:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get('/api/users/profile/:phone', async (req, res) => {
  try {
    const { phone } = req.params || {};
    if (!phone) return res.status(400).json({ message: 'phone is required' });

    const result = await pool.query('SELECT * FROM users WHERE phone=$1 LIMIT 1', [phone]);
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* =====================================
   GET USER BOOKINGS (active + history)
   ===================================== */
app.get('/api/users/bookings/:phone', async (req, res) => {
  try {
    const { phone } = req.params || {};
    if (!phone) return res.status(400).json({ message: 'phone is required' });

    const activeResult = await pool.query(
      `SELECT b.*, p.name AS location FROM bookings b
       LEFT JOIN parking_areas p ON p.id = b.parking_id
       WHERE b.phone=$1`,
      [phone]
    );

    const historyResult = await pool.query(
      `SELECT h.*, p.name AS location FROM booking_history h
       LEFT JOIN parking_areas p ON p.id = h.parking_id
       WHERE h.phone=$1`,
      [phone]
    );

    const activeBookings = activeResult.rows.map(b => ({ ...b, status: 'active' }));
    const historicalBookings = historyResult.rows.map(h => ({ ...h, status: 'completed' }));

    const allBookings = [...activeBookings, ...historicalBookings];
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

/* ============================
   GENERAL: parking_areas
   ============================ */
app.get('/api/parking_areas', async (req, res) => {
  try {
    const areas = await pool.query('SELECT * FROM parking_areas');
    const withLocation = areas.rows.map(a => ({ ...a, location: { lat: a.lat, lng: a.lng } }));
    return res.status(200).json(withLocation);
  } catch (error) {
    console.error('Error fetching parking areas:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get('/api/parking_areas/:id', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid parking area ID' });

    const result = await pool.query('SELECT * FROM parking_areas WHERE id=$1', [id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Parking area not found' });

    const area = result.rows[0];
    return res.status(200).json({ ...area, location: { lat: area.lat, lng: area.lng } });
  } catch (error) {
    console.error('Error fetching parking area details:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* ============================
   HOLDS: temporary reservation
   ============================ */
app.post('/api/holds', async (req, res) => {
  try {
    const { parking_id, slot_number, vehicle_type, phone } = req.body || {};
    if (!parking_id || !slot_number || !vehicle_type) {
      return res.status(400).json({ message: "parking_id, slot_number & vehicle_type required" });
    }

    const parkingId = toInt(parking_id);
    const vType = vehicle_type.toLowerCase();

    // Check booked within buffer window - block if inside ±BUFFER
    const booked = await pool.query(
      `SELECT id, entry_time, is_verified FROM bookings
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3`,
      [parkingId, slot_number, vType]
    );

    let isBlocked = false;
    if (booked.rows.length > 0) {
      const entry = new Date(booked.rows[0].entry_time);
      const existingStart = new Date(entry.getTime() - BUFFER_MINUTES * 60000);
      const existingEnd = new Date(entry.getTime() + BUFFER_MINUTES * 60000);
      const now = new Date();
      if (now >= existingStart && now <= existingEnd) {
        isBlocked = true;
      }
    }

    if (isBlocked) {
      return res.status(400).json({ message: "Slot currently in active window" });
    }

    // Check existing valid hold
    const existingHold = await pool.query(
      `SELECT 1 FROM slot_holds
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3
       AND hold_expires_at > NOW()`,
      [parkingId, slot_number, vType]
    );
    if (existingHold.rows.length > 0) {
      return res.status(400).json({ message: "Slot already held" });
    }

    // Create new hold using param interval (safe)
    // We'll rely on Postgres interval casting with a parameter (as text)
    await pool.query(
      `INSERT INTO slot_holds
       (parking_id, slot_number, vehicle_type, phone, hold_expires_at)
       VALUES ($1,$2,$3,$4,NOW() + ($5 || ' seconds')::interval)`,
      [parkingId, slot_number, vType, phone || "", String(HOLD_SECONDS)]
    );

    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number,
      vehicle_type: vType,
      status: "held",
      phone: phone || null,
    });

    return res.status(200).json({
      message: "Slot temporarily held",
      slot_number,
      expires_in_sec: HOLD_SECONDS
    });
  } catch (e) {
    console.error("Error creating hold:", e);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ==========================================
   GET SLOTS (USER) - hybrid logic + buffer
   ========================================== */
app.get('/api/parking_areas/:id/slots', async (req, res) => {
  try {
    const parking_id = toInt(req.params.id);
    if (!parking_id) return res.status(400).json({ message: 'Invalid parking area ID' });

    const { vehicle_type } = req.query || {};
    if (!vehicle_type || !['car', 'bike'].includes(vehicle_type.toLowerCase())) {
      return res.status(400).json({ message: 'Valid vehicle_type query param required' });
    }
    const vType = vehicle_type.toLowerCase();

    const areaResult = await pool.query('SELECT * FROM parking_areas WHERE id=$1', [parking_id]);
    if (!areaResult.rows.length) return res.status(404).json({ message: 'Parking area not found' });

    const parkingArea = areaResult.rows[0];
    const totalSlots = (vType === 'car') ? parkingArea.total_car_slots : parkingArea.total_bike_slots;
    if (!totalSlots || totalSlots === 0) return res.status(200).json([]);

    // Get active bookings for this parking area & vehicle type (we'll need data per slot)
    const activeBookings = await pool.query(
      `SELECT id, slot_number, entry_time, phone, is_verified
       FROM bookings
       WHERE parking_id=$1 AND vehicle_type=$2`,
      [parking_id, vType]
    );

    // Map bookings by slot_number for quick lookup
    const bookingMap = new Map();
    for (const b of activeBookings.rows) {
      bookingMap.set(Number(b.slot_number), b);
    }

    // Active holds
    const activeHolds = await pool.query(
      `SELECT slot_number, phone FROM slot_holds
       WHERE parking_id=$1 AND vehicle_type=$2
       AND hold_expires_at > NOW()`,
      [parking_id, vType]
    );
    const holdMap = new Map(activeHolds.rows.map(h => [Number(h.slot_number), h]));

    const allSlots = [];
    const now = new Date();

    for (let i = 1; i <= totalSlots; i++) {
      const slot_number = i;
      let status = "available";
      let booking_id = null;
      let booking_phone = null;
      let is_verified = false;
      let entry_time = null;

      const booking = bookingMap.get(slot_number);
      if (booking) {
        booking_id = booking.id;
        booking_phone = booking.phone;
        is_verified = !!booking.is_verified;
        entry_time = booking.entry_time ? new Date(booking.entry_time) : null;

        // Buffer logic: treat as booked if now within ±BUFFER of entry_time
        if (entry_time) {
          const startWindow = new Date(entry_time.getTime() - BUFFER_MINUTES * 60000);
          const endWindow = new Date(entry_time.getTime() + BUFFER_MINUTES * 60000);
          if (now >= startWindow && now <= endWindow) {
            status = "booked";
          }
        }
      }

      // Held check overrides (highest priority)
      if (holdMap.has(slot_number)) {
        status = "held";
        booking_phone = holdMap.get(slot_number).phone || booking_phone;
      }

      allSlots.push({
        parking_id,
        slot_number,
        vehicle_type: vType,
        status,
        booking_id,
        booking_phone,
        is_verified,
        entry_time,
      });
    }

    return res.status(200).json(allSlots);
  } catch (error) {
    console.error('Error fetching slots:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* ============================
   BOOKING PROCESS HELPER
   - sets is_verified=false initially
   ============================ */
async function processBooking(req, res) {
  try {
    const {
      parking_id,
      slot_number,
      vehicle_type,
      number_plate,
      entry_time,
      phone,
      payment_id,
    } = req.body || {};

    const parkingId = toInt(parking_id);
    const slotNum = Number.isInteger(Number(slot_number)) ? parseInt(slot_number, 10) : null;
    if (!parkingId || !slotNum || !vehicle_type) {
      return res.status(400).json({ message: 'parking_id, slot_number and vehicle_type are required' });
    }
    const vType = vehicle_type.toLowerCase();

    console.log('processBooking called:', { parkingId, slotNum, vType, number_plate, entry_time, phone, payment_id });

    // Get parking area
    const areaResult = await pool.query('SELECT * FROM parking_areas WHERE id=$1', [parkingId]);
    if (!areaResult.rows.length) return res.status(404).json({ message: 'Parking area not found' });
    const parkingArea = areaResult.rows[0];
    const totalSlotsKey = vType === 'car' ? 'total_car_slots' : 'total_bike_slots';
    const totalSlots = parkingArea[totalSlotsKey];
    if (slotNum > totalSlots || slotNum <= 0) return res.status(400).json({ message: 'Invalid slot_number for the parking area' });

    // Time overlap check - ensure no overlapping booking within buffer windows
    const newStart = new Date(entry_time);
    const newEnd = new Date(newStart.getTime() + 15 * 60000); // booking window length - configurable

    const conflicts = await pool.query(
      `SELECT entry_time FROM bookings
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3`,
      [parkingId, slotNum, vType]
    );

    for (const row of conflicts.rows) {
      const existing = new Date(row.entry_time);
      const existingStart = new Date(existing.getTime() - BUFFER_MINUTES * 60000);
      const existingEnd = new Date(existing.getTime() + BUFFER_MINUTES * 60000);
      if (newStart < existingEnd && newEnd > existingStart) {
        return res.status(400).json({ message: "This slot has a booking near your selected time.", code: "TIME_OVERLAP" });
      }
    }

    // Remove existing hold (convert hold -> booking)
    await pool.query(`DELETE FROM slot_holds WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3`, [parkingId, slotNum, vType]);

    // HYBRID MODEL — ensure slot entry exists
    const slotResult = await pool.query(
      `INSERT INTO slots (parking_id, slot_number, vehicle_type, last_booked_at, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW(),NOW())
       ON CONFLICT (parking_id,vehicle_type,slot_number)
       DO UPDATE SET last_booked_at=NOW(), updated_at=NOW()
       RETURNING id`,
      [parkingId, slotNum, vType]
    );
    const slotId = slotResult.rows[0].id;
    const now = new Date();
    const entryTime = entry_time ? new Date(entry_time) : now;
    const bookingAmount = req.body.amount || 0;

    // Insert booking (is_verified defaults to false in DB but we'll set explicitly)
    const bookingResult = await pool.query(
      `INSERT INTO bookings
       (parking_id, slot_id, slot_number, vehicle_type, number_plate, phone,
        entry_time, exit_time, payment_id, amount, is_verified, actual_entry_time, verified_at, verified_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,NULL,NULL,NULL,$11,$12)
       RETURNING id`,
      [
        parkingId,
        slotId,
        slotNum,
        vType,
        number_plate || '',
        phone || '',
        entryTime,
        null,
        payment_id || '',
        bookingAmount,
        now,
        now
      ]
    );

    // Update parking area counts
    if (vType === 'car') {
      await pool.query(
        `UPDATE parking_areas
         SET available_car_slots = GREATEST(available_car_slots - 1, 0),
             booked_car_slots = booked_car_slots + 1
         WHERE id=$1`,
        [parkingId]
      );
    } else {
      await pool.query(
        `UPDATE parking_areas
         SET available_bike_slots = GREATEST(available_bike_slots - 1, 0),
             booked_bike_slots = booked_bike_slots + 1
         WHERE id=$1`,
        [parkingId]
      );
    }

    // Emit socket with booking metadata (unverified initially)
    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number: slotNum,
      vehicle_type: vType,
      status: "booked",
      phone: phone || null,
      booking_id: bookingResult.rows[0].id,
      is_verified: false,
      entry_time: entryTime,
    });

    console.log('Booking created id=', bookingResult.rows[0].id);

    return res.status(200).json({
      message: 'Slot booked successfully',
      booking_id: bookingResult.rows[0].id,
      slot_number: slotNum,
    });
  } catch (error) {
    console.error('Error booking slot:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
}

app.post('/api/bookings', processBooking);

/* ===========================================
   USER CANCEL BOOKING (refund + archive)
   =========================================== */
app.post("/api/bookings/cancel", async (req, res) => {
  try {
    const { booking_id, parking_id, vehicle_type } = req.body || {};
    if (!booking_id || !parking_id || !vehicle_type) {
      return res.status(400).json({ message: "booking_id, parking_id, and vehicle_type required" });
    }

    const bookingId = toInt(booking_id);
    const parkingId = toInt(parking_id);
    const vType = vehicle_type.toLowerCase();

    const bkRes = await pool.query(`SELECT * FROM bookings WHERE id=$1 AND parking_id=$2 AND vehicle_type=$3 LIMIT 1`, [bookingId, parkingId, vType]);
    if (!bkRes.rows.length) return res.status(404).json({ message: "Active booking not found" });

    const booking = bkRes.rows[0];
    const now = new Date();
    const entryTime = booking.entry_time ? new Date(booking.entry_time) : now;
    const diffSeconds = Math.floor((entryTime - now) / 1000);

    let refundPercent = 0;
    if (diffSeconds > 3600) refundPercent = 60;
    else if (diffSeconds > 1800) refundPercent = 40;
    else if (diffSeconds > 900) refundPercent = 40;
    else refundPercent = 0;

    const refundAmount = Math.round(((booking.amount || 0) * refundPercent) / 100);

    // Razorpay refund (optional)
    let razorRefund = null;
    if (refundAmount > 0 && booking.payment_id) {
      try {
        razorRefund = await razorpay.payments.refund(booking.payment_id, { amount: refundAmount });
      } catch (e) {
        console.error("Razorpay refund error:", e);
      }
    }

    // Archive into history
    await pool.query(
      `INSERT INTO booking_history
       (booking_id, parking_id, slot_id, slot_number, phone, vehicle_type, number_plate,
        entry_time, exit_time, payment_id, amount, archived_at, cancelled, cancelled_at, refund_percent, refund_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),true,NOW(),$12,$13)`,
      [
        booking.id,
        booking.parking_id,
        booking.slot_id,
        booking.slot_number,
        booking.phone,
        booking.vehicle_type,
        booking.number_plate,
        booking.entry_time,
        now,
        booking.payment_id || "",
        booking.amount || 0,
        refundPercent,
        refundAmount
      ]
    );

    // Delete booking
    await pool.query(`DELETE FROM bookings WHERE id=$1`, [bookingId]);

    // Update slot counters
    if (vType === "car") {
      await pool.query(
        `UPDATE parking_areas SET available_car_slots = available_car_slots + 1, booked_car_slots = booked_car_slots - 1 WHERE id=$1`,
        [parkingId]
      );
    } else {
      await pool.query(
        `UPDATE parking_areas SET available_bike_slots = available_bike_slots + 1, booked_bike_slots = booked_bike_slots - 1 WHERE id=$1`,
        [parkingId]
      );
    }

    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number: booking.slot_number,
      vehicle_type: vType,
      status: "available",
    });

    return res.status(200).json({
      message: "Booking cancelled",
      refund_percent: refundPercent,
      refund_amount: refundAmount,
      razorpay_refund: razorRefund,
    });
  } catch (e) {
    console.error("Cancel Booking Error:", e);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

/* ============================
   OWNER endpoints
   ============================ */

// Get all owners
app.get('/api/owner/all', async (req, res) => {
  try {
    const owners = await pool.query('SELECT id, phone, parking_area_name, created_at, updated_at FROM register_login');
    return res.status(200).json(owners.rows);
  } catch (error) {
    console.error('Error fetching all owners:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Register owner
app.post('/api/owner/register', async (req, res) => {
  const { phone, parking_area_name, password } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  try {
    const existing = await pool.query('SELECT * FROM register_login WHERE phone=$1 LIMIT 1', [phone]);
    if (existing.rows.length > 0) return res.status(400).json({ message: 'User already exists' });

    const now = new Date();
    const ownerResult = await pool.query(
      `INSERT INTO register_login (phone, parking_area_name, password, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, phone, parking_area_name, created_at, updated_at`,
      [phone, parking_area_name, password, now, now]
    );

    return res.status(201).json({ message: 'Registered successfully', owner: ownerResult.rows[0] });
  } catch (error) {
    if (error && error.code === '23505') return res.status(400).json({ message: 'Phone already registered' });
    console.error('Error registering owner:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Owner login
app.post('/api/owner/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone) return res.status(400).json({ message: 'phone is required' });

    let result;
    if (password) {
      result = await pool.query('SELECT * FROM register_login WHERE phone=$1 AND password=$2 LIMIT 1', [phone, password]);
    } else {
      result = await pool.query('SELECT * FROM register_login WHERE phone=$1 LIMIT 1', [phone]);
    }

    if (!result.rows.length) return res.status(400).json({ message: 'Invalid credentials' });

    const owner = result.rows[0];
    return res.status(200).json({ message: 'Login successful', phone: owner.phone, parking_area_name: owner.parking_area_name });
  } catch (error) {
    console.error('Error logging in owner:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Create/Update parking area (unchanged hybrid behavior)
app.post('/api/owner/parking_areas', async (req, res) => {
  const { name: ownerPhone, parking_area_name, location, total_car_slots, total_bike_slots } = req.body || {};
  if (!ownerPhone) return res.status(400).json({ message: 'owner phone (name) is required' });
  if (!parking_area_name) return res.status(400).json({ message: 'parking_area_name is required' });

  try {
    const existingAreaResult = await pool.query('SELECT * FROM parking_areas WHERE name=$1 LIMIT 1', [parking_area_name]);
    const existingArea = existingAreaResult.rows[0];

    const newTotalCarSlots = (typeof total_car_slots === 'number') ? total_car_slots : (existingArea ? existingArea.total_car_slots : 0);
    const newTotalBikeSlots = (typeof total_bike_slots === 'number') ? total_bike_slots : (existingArea ? existingArea.total_bike_slots : 0);

    await pool.query(`UPDATE register_login SET parking_area_name=$1, updated_at=NOW() WHERE phone=$2`, [parking_area_name, ownerPhone]);

    const lat = location?.lat ?? null;
    const lng = location?.lng ?? null;

    if (existingArea) {
      const currentCarSlots = existingArea.total_car_slots;
      const currentBikeSlots = existingArea.total_bike_slots;
      const carSlotsChanged = newTotalCarSlots !== currentCarSlots;
      const bikeSlotsChanged = newTotalBikeSlots !== currentBikeSlots;

      const setParts = ['lat=$1', 'lng=$2', 'total_car_slots=$3', 'total_bike_slots=$4', 'updated_at=NOW()'];
      const values = [lat, lng, newTotalCarSlots, newTotalBikeSlots];

      if (carSlotsChanged) {
        setParts.push('available_car_slots=$5', 'booked_car_slots=0');
        values.push(newTotalCarSlots);
      }
      if (bikeSlotsChanged) {
        const bikeIndex = carSlotsChanged ? 6 : 5;
        setParts.push(`available_bike_slots=$${bikeIndex}`, 'booked_bike_slots=0');
        values.push(newTotalBikeSlots);
      }

      const whereIndex = values.length + 1;
      const sql = `UPDATE parking_areas SET ${setParts.join(', ')} WHERE name=$${whereIndex}`;
      values.push(parking_area_name);
      await pool.query(sql, values);

      if (carSlotsChanged || bikeSlotsChanged) {
        const parkingId = existingArea.id;
        await pool.query('DELETE FROM slots WHERE parking_id=$1', [parkingId]);
        await pool.query('DELETE FROM bookings WHERE parking_id=$1', [parkingId]);

        return res.status(200).json({
          message: 'Parking area updated. All slots/bookings reset due to capacity change (Hybrid Model).'
        });
      }

      return res.status(200).json({ message: 'Parking area updated successfully' });
    } else {
      const now = new Date();
      const result = await pool.query(
        `INSERT INTO parking_areas
         (name, lat, lng, total_car_slots, available_car_slots, booked_car_slots,
          total_bike_slots, available_bike_slots, booked_bike_slots, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          parking_area_name, lat, lng,
          newTotalCarSlots, newTotalCarSlots, 0,
          newTotalBikeSlots, newTotalBikeSlots, 0,
          now, now
        ]
      );
      return res.status(201).json({ message: 'Parking area created (Hybrid Model - no initial slots created)', id: result.rows[0].id });
    }
  } catch (error) {
    console.error('Error processing parking area:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get('/api/owner/parking_areas', async (req, res) => {
  try {
    const areas = await pool.query('SELECT * FROM parking_areas');
    const withLocation = areas.rows.map(a => ({ ...a, location: { lat: a.lat, lng: a.lng } }));
    return res.status(200).json(withLocation);
  } catch (error) {
    console.error('Error fetching parking areas:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* =====================================
   GET SLOTS (OWNER) - include booking meta
   ===================================== */
app.get('/api/owner/parking_areas/:id/slots', async (req, res) => {
  try {
    const parking_id = toInt(req.params.id);
    if (!parking_id) return res.status(400).json({ message: 'Invalid parking area ID' });

    const { vehicle_type } = req.query || {};
    if (!vehicle_type || !['car', 'bike'].includes(vehicle_type.toLowerCase())) {
      return res.status(400).json({ message: 'Valid vehicle_type query param required' });
    }
    const vType = vehicle_type.toLowerCase();

    const areaResult = await pool.query('SELECT * FROM parking_areas WHERE id=$1', [parking_id]);
    if (!areaResult.rows.length) return res.status(404).json({ message: 'Parking area not found' });

    const parkingArea = areaResult.rows[0];
    const totalSlots = (vType === 'car') ? parkingArea.total_car_slots : parkingArea.total_bike_slots;
    if (!totalSlots || totalSlots === 0) return res.status(200).json([]);

    // bookings + holds
    const activeBookings = await pool.query(
      `SELECT id, slot_number, entry_time, phone, is_verified
       FROM bookings WHERE parking_id=$1 AND vehicle_type=$2`,
      [parking_id, vType]
    );
    const bookingSet = new Map(activeBookings.rows.map(b => [Number(b.slot_number), b]));

    const activeHolds = await pool.query(
      `SELECT slot_number, phone FROM slot_holds WHERE parking_id=$1 AND vehicle_type=$2 AND hold_expires_at > NOW()`,
      [parking_id, vType]
    );
    const holdSet = new Map(activeHolds.rows.map(h => [Number(h.slot_number), h]));

    const allSlots = Array.from({ length: totalSlots }, (_, i) => {
      const slot_number = i + 1;
      let status = "available";
      let booking_id = null;
      let booking_phone = null;
      let is_verified = false;
      let entry_time = null;

      const b = bookingSet.get(slot_number);
      if (b) {
        booking_id = b.id;
        booking_phone = b.phone;
        is_verified = !!b.is_verified;
        entry_time = b.entry_time ? new Date(b.entry_time) : null;
        if (entry_time) {
          const startWindow = new Date(entry_time.getTime() - BUFFER_MINUTES * 60000);
          const endWindow = new Date(entry_time.getTime() + BUFFER_MINUTES * 60000);
          const now = new Date();
          if (now >= startWindow && now <= endWindow) status = "booked";
        }
      }

      if (holdSet.has(slot_number)) {
        status = "held";
        booking_phone = holdSet.get(slot_number).phone || booking_phone;
      }

      return {
        parking_id,
        slot_number,
        vehicle_type: vType,
        status,
        booking_id,
        booking_phone,
        is_verified,
        entry_time
      };
    });

    return res.status(200).json(allSlots);
  } catch (error) {
    console.error('Error fetching slots:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* =====================================
   Owner: Get Booking Details for a slot
   ===================================== */
app.get('/api/owner/bookings', async (req, res) => {
  try {
    const { parking_id, slot_number, vehicle_type } = req.query || {};
    if (!parking_id || !slot_number || !vehicle_type) return res.status(400).json({ message: 'parking_id, slot_number, and vehicle_type query params required' });

    const parkingId = toInt(parking_id);
    const numSlot = parseInt(slot_number, 10);
    const vType = vehicle_type.toLowerCase();
    if (!parkingId || isNaN(numSlot)) return res.status(400).json({ message: 'Invalid id(s)/slot_number' });

    const result = await pool.query(
      `SELECT * FROM bookings WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3 LIMIT 1`,
      [parkingId, numSlot, vType]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'No active booking found for this slot.' });

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching active booking:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* =========================================
   Owner: Verify booking (car arrived)
   - Sets is_verified = true, actual_entry_time, verified_at, verified_by
   ========================================= */
app.post('/api/owner/bookings/verify', async (req, res) => {
  try {
    const { booking_id, verifier } = req.body || {};
    if (!booking_id) return res.status(400).json({ message: 'booking_id required' });

    const bId = toInt(booking_id);
    if (!bId) return res.status(400).json({ message: 'Invalid booking_id' });

    // Update booking to verified state
    const upd = await pool.query(
      `UPDATE bookings SET is_verified=true, verified_at=NOW(), verified_by=$2, actual_entry_time=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [bId, verifier || null]
    );

    if (!upd.rows.length) return res.status(404).json({ message: 'Booking not found' });

    const booking = upd.rows[0];

    // Real-time notify
    io.to(`parking_${booking.parking_id}_${booking.vehicle_type}`).emit("slot_update", {
      parking_id: booking.parking_id,
      slot_number: booking.slot_number,
      vehicle_type: booking.vehicle_type,
      status: "booked",
      booking_id: booking.id,
      is_verified: true,
      verified_at: booking.verified_at,
      verified_by: booking.verified_by,
      actual_entry_time: booking.actual_entry_time
    });

    return res.status(200).json({ message: 'Booking verified', booking });
  } catch (e) {
    console.error('Verify booking error:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* =========================================
   Owner: Complete booking and free slot (Option B)
   ========================================= */
app.post('/api/owner/bookings/complete', async (req, res) => {
  try {
    const { booking_id, parking_id, vehicle_type, exit_time, amount, payment_id } = req.body || {};
    if (!booking_id || !parking_id || !vehicle_type) return res.status(400).json({ message: 'booking_id, parking_id, and vehicle_type are required' });

    const bookingId = toInt(booking_id);
    const parkingId = toInt(parking_id);
    const vType = vehicle_type.toLowerCase();
    if (!bookingId || !parkingId) return res.status(400).json({ message: 'Invalid id(s)' });

    const activeResult = await pool.query(`SELECT * FROM bookings WHERE id=$1 AND parking_id=$2 AND vehicle_type=$3 LIMIT 1`, [bookingId, parkingId, vType]);
    if (!activeResult.rows.length) return res.status(404).json({ message: 'No active booking found with this ID' });

    const activeBooking = activeResult.rows[0];
    const finalExitTime = exit_time ? new Date(exit_time) : new Date();
    const finalAmount = amount || 0;

    await pool.query(
      `INSERT INTO booking_history
       (booking_id, parking_id, slot_id, slot_number, phone, vehicle_type, number_plate, entry_time, exit_time, payment_id, amount, archived_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
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
      ]
    );

    await pool.query('DELETE FROM bookings WHERE id=$1', [bookingId]);

    if (vType === 'car') {
      await pool.query(`UPDATE parking_areas SET available_car_slots = available_car_slots + 1, booked_car_slots = booked_car_slots - 1 WHERE id=$1`, [parkingId]);
    } else {
      await pool.query(`UPDATE parking_areas SET available_bike_slots = available_bike_slots + 1, booked_bike_slots = booked_bike_slots - 1 WHERE id=$1`, [parkingId]);
    }

    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number: activeBooking.slot_number,
      vehicle_type: vType,
      status: "available",
    });

    return res.status(200).json({ message: 'Booking completed and slot freed', amount: finalAmount });
  } catch (error) {
    console.error('Error completing booking:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* ============================
   GLOBAL ERROR HANDLER
   ============================ */
app.use((err, req, res, next) => {
  console.error('GLOBAL ERROR:', err && (err.stack || err.message || err));
  if (!res.headersSent) {
    res.status(500).json({ message: 'Internal Server Error', error: err.message || String(err) });
  }
});

/* ============================
   START SERVER + WebSocket
   ============================ */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// Socket listeners
io.on("connection", (socket) => {
  console.log("✅ WebSocket connected:", socket.id);

  socket.on("join_parking", ({ parking_id, vehicle_type }) => {
    if (!parking_id || !vehicle_type) return;
    const room = `parking_${parking_id}_${String(vehicle_type).toLowerCase()}`;
    socket.join(room);
    console.log(`✅ ${socket.id} joined ${room}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ WebSocket disconnected:", socket.id);
  });
});

/* ===========================================
   Background Job: cleanup expired holds
   - deletes slot_holds where hold_expires_at < NOW()
   - emits slot_update available for affected slots
   =========================================== */
setInterval(async () => {
  try {
    const expired = await pool.query(
      `DELETE FROM slot_holds
       WHERE hold_expires_at < NOW()
       RETURNING parking_id, slot_number, vehicle_type`
    );

    expired.rows.forEach(({ parking_id, slot_number, vehicle_type }) => {
      io.to(`parking_${parking_id}_${vehicle_type}`).emit("slot_update", {
        parking_id,
        slot_number,
        vehicle_type,
        status: "available",
      });
    });
  } catch (error) {
    console.error("Hold cleanup failed:", error);
  }
}, HOLD_CLEANUP_INTERVAL);


/* ===========================================
   Background Job: expire unverified bookings
   =========================================== */
setInterval(async () => {
  try {
    // 1) Select expired unverified bookings (NO RETURNING)
    const expired = await pool.query(
      `SELECT * FROM bookings
       WHERE is_verified = false
       AND (entry_time + ($1 || ' minutes')::interval) < NOW()`,
      [String(BUFFER_MINUTES)]
    );

    for (const b of expired.rows) {
      // 2) Insert into history
      await pool.query(
        `INSERT INTO booking_history
         (booking_id, parking_id, slot_id, slot_number, phone, vehicle_type,
          number_plate, entry_time, exit_time, payment_id, amount,
          archived_at, cancelled, cancelled_at, not_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),true,NOW(),true)`,
        [
          b.id, b.parking_id, b.slot_id, b.slot_number,
          b.phone, b.vehicle_type, b.number_plate,
          b.entry_time, null,
          b.payment_id || '', b.amount || 0
        ]
      );

      // 3) Delete original booking
      await pool.query(`DELETE FROM bookings WHERE id=$1`, [b.id]);

      // 4) Update slot counters
      if (b.vehicle_type === 'car') {
        await pool.query(
          `UPDATE parking_areas
           SET available_car_slots = available_car_slots + 1,
               booked_car_slots = GREATEST(booked_car_slots - 1, 0)
           WHERE id=$1`,
          [b.parking_id]
        );
      } else {
        await pool.query(
          `UPDATE parking_areas
           SET available_bike_slots = available_bike_slots + 1,
               booked_bike_slots = GREATEST(booked_bike_slots - 1, 0)
           WHERE id=$1`,
          [b.parking_id]
        );
      }

      // 5) Emit slot free update
      io.to(`parking_${b.parking_id}_${b.vehicle_type}`).emit("slot_update", {
        parking_id: b.parking_id,
        slot_number: b.slot_number,
        vehicle_type: b.vehicle_type,
        status: "available",
        reason: "expired_not_verified"
      });
    }
  } catch (err) {
    console.error('Unverified booking cleanup failed:', err);
  }
}, NOT_VERIFIED_CHECK_INTERVAL);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server + WebSocket running on http://0.0.0.0:${PORT}`);
});
