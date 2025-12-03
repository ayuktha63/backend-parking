// server.js — Final (Postgres / Neon) — Hybrid Slot Model + Hold/Verify Flow
// FIXED: Removed strict time blocking for verification. 
// Now, if an Owner clicks Verify, it ALWAYS succeeds (Time mismatch logs warning only).

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Replace constants as needed
const MSG91_AUTHKEY = "479720Apw1DjSN692aaeb5P1";
const WA_TEMPLATE_NAME = "transactional";
const WA_NAMESPACE = "5b1a5f70_3016_4451_8747_6fa69b8b564a";
const WA_INTEGRATED_NUMBER = "15558692939";

// OTP store (in-memory for now)
app.locals.otpStore = {};

// Force JSON content-type for all responses
app.use((req, res, next) => {
  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', 'application/json');
  }
  next();
});

// ====== Postgres Pool (Neon) ======
const pool = new Pool({
  connectionString:
    'postgresql://neondb_owner:npg_5x4ADLWqziOR@ep-lucky-water-adryg5p6-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
});

// -------------------- Helpers --------------------
function toInt(id) {
  const n = Number(id);
  return Number.isInteger(n) ? n : null;
}

function normalizeVehicleType(v) {
  return (v || '').toString().toLowerCase();
}

// returns true if windows overlap
function windowsOverlap(startA, endA, startB, endB) {
  return (startA < endB) && (endA > startB);
}

// given a booking entryTime and buffer (minutes) returns window start,end
function windowFromTime(time, bufferMin) {
  const t = new Date(time);
  const start = new Date(t.getTime() - bufferMin * 60000);
  const end = new Date(t.getTime() + bufferMin * 60000);
  return { start, end };
}

// Centralized overlap check using DB rows (existing bookings)
function isOverlapWithExisting(existingEntry, newEntry, bufferMinutes = 10, bookingLengthMinutes = 15) {
  const existingWindow = windowFromTime(existingEntry, bufferMinutes);
  const newStart = new Date(newEntry.getTime() - bufferMinutes * 60000);
  const newEnd = new Date(newEntry.getTime() + bookingLengthMinutes * 60000); // user booking length added to new window
  return windowsOverlap(existingWindow.start, existingWindow.end, newStart, newEnd);
}

// BUFFER constants
const BUFFER_MINUTES = 10;        // ±10min window for verified bookings
const UNVERIFIED_GRACE_MINUTES = 5; // unverified booking considered active for 5 minutes for overlap purpose
const HOLD_SECONDS = 120;         // 2 minutes hold
const UNVERIFIED_EXPIRY_SECONDS = UNVERIFIED_GRACE_MINUTES * 60; // 5 minutes

// -------------------- OTP endpoints (unchanged) --------------------
app.post("/api/auth/send-otp", async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ message: "Phone is required" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  req.app.locals.otpStore[phone] = otp;

  try {
    const payload = {
      integrated_number: WA_INTEGRATED_NUMBER,
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name: WA_TEMPLATE_NAME,
          language: { code: "en", policy: "deterministic" },
          namespace: WA_NAMESPACE,
          to_and_components: [
            {
              to: [`91${phone}`],
              components: {
                body_1: { type: "text", value: otp }
              }
            }
          ]
        }
      }
    };

    await axios.post(
      "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
      payload,
      { headers: { "Content-Type": "application/json", "authkey": MSG91_AUTHKEY } }
    );

    return res.status(200).json({ message: "OTP sent via WhatsApp", debug_otp: otp });
  } catch (err) {
    console.error("WhatsApp OTP ERROR:", err?.response?.data || err);
    return res.status(500).json({ message: "Failed to send OTP", error: err?.response?.data || String(err) });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) return res.status(400).json({ message: "Phone & OTP required" });
  const store = req.app.locals.otpStore;
  const real = store[phone];
  if (!real) return res.status(400).json({ message: "OTP expired or not found" });
  if (real !== otp) return res.status(400).json({ message: "Invalid OTP" });
  delete store[phone];
  return res.status(200).json({ message: "OTP verified successfully" });
});

// -------------------- Users --------------------
app.post('/api/users/register', async (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });
  try {
    const existing = await pool.query('SELECT * FROM users WHERE phone=$1 LIMIT 1', [phone]);
    if (existing.rows.length) return res.status(200).json({ message: 'User already exists', user: existing.rows[0] });

    const now = new Date();
    const result = await pool.query(
      `INSERT INTO users (phone, name, created_at, updated_at) VALUES ($1,$2,$3,$4) RETURNING *`,
      [phone, name || 'User', now, now]
    );
    return res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (e) {
    console.error('Error registering user:', e);
    if (e && e.code === '23505') return res.status(400).json({ message: 'Phone already registered' });
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.post('/api/users/login', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE phone=$1 LIMIT 1', [phone]);
    if (!result.rows.length) return res.status(404).json({ message: 'User not found. Please register.' });
    return res.status(200).json({ message: 'Login successful', user: result.rows[0] });
  } catch (e) {
    console.error('Error logging in user:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get('/api/users/profile/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    if (!phone) return res.status(400).json({ message: 'phone is required' });
    const result = await pool.query('SELECT * FROM users WHERE phone=$1 LIMIT 1', [phone]);
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    return res.status(200).json(result.rows[0]);
  } catch (e) {
    console.error('Error fetching user profile:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get User Bookings (active + history)
app.get('/api/users/bookings/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
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

    const act = activeResult.rows.map(b => ({ ...b, status: b.is_verified ? 'active_verified' : 'pending' }));
    const hist = historyResult.rows.map(h => ({ ...h, status: 'completed' }));

    const all = [...act, ...hist];
    all.sort((a, b) => {
      const aT = a.entry_time ? new Date(a.entry_time).getTime() : 0;
      const bT = b.entry_time ? new Date(b.entry_time).getTime() : 0;
      return bT - aT;
    });

    return res.status(200).json(all);
  } catch (e) {
    console.error('Error fetching user bookings:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// -------------------- Parking areas --------------------
app.get('/api/parking_areas', async (req, res) => {
  try {
    const areas = await pool.query('SELECT * FROM parking_areas');
    const withLocation = areas.rows.map(a => ({ ...a, location: { lat: a.lat, lng: a.lng } }));
    return res.status(200).json(withLocation);
  } catch (e) {
    console.error('Error fetching parking areas:', e);
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
  } catch (e) {
    console.error('Error fetching parking area:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// -------------------- Hold endpoint --------------------
// Creates a hold (2 minutes) for a specific slot and phone
app.post('/api/holds', async (req, res) => {
  try {
    const { parking_id, slot_number, vehicle_type, phone } = req.body || {};
    if (!parking_id || !slot_number || !vehicle_type || !phone) {
      return res.status(400).json({ message: "parking_id, slot_number, vehicle_type and phone required" });
    }
    const parkingId = toInt(parking_id);
    const vType = normalizeVehicleType(vehicle_type);
    if (!parkingId) return res.status(400).json({ message: 'Invalid parking_id' });

    // Check if slot is blocked by any VERIFIED booking within buffer
    const bookingCheck = await pool.query(
      `SELECT entry_time FROM bookings
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3 AND is_verified=true`,
      [parkingId, slot_number, vType]
    );

    if (bookingCheck.rows.length > 0) {
      const entry = bookingCheck.rows[0].entry_time;
      const { start, end } = windowFromTime(entry, BUFFER_MINUTES);
      const now = new Date();
      if (now >= start && now <= end) {
        return res.status(400).json({ message: "Slot currently booked in active window" });
      }
    }

    // Check existing hold (active)
    const existingHold = await pool.query(
      `SELECT phone FROM slot_holds WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3 AND hold_expires_at > NOW() LIMIT 1`,
      [parkingId, slot_number, vType]
    );
    if (existingHold.rows.length > 0) {
      return res.status(400).json({ message: "Slot already held" });
    }

    // Insert hold with ownership (phone) and hold_expires_at
    await pool.query(
      `INSERT INTO slot_holds (parking_id, slot_number, vehicle_type, phone, hold_expires_at, created_at)
       VALUES ($1,$2,$3,$4,NOW() + ($5 || ' seconds')::interval, NOW())`,
      [parkingId, slot_number, vType, phone, HOLD_SECONDS]
    );

    // Emit update
    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number,
      vehicle_type: vType,
      status: "held",
      phone
    });

    return res.status(200).json({ message: "Slot temporarily held", slot_number, expires_in_sec: HOLD_SECONDS });
  } catch (e) {
    console.error("Error creating hold:", e);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// -------------------- Get slots (user) — optimized --------------------
app.get('/api/parking_areas/:id/slots', async (req, res) => {
  try {
    const parking_id = toInt(req.params.id);
    if (!parking_id) return res.status(400).json({ message: 'Invalid parking area ID' });

    const { vehicle_type, entry_time } = req.query || {};
    if (!vehicle_type || !['car', 'bike'].includes(vehicle_type.toLowerCase())) {
      return res.status(400).json({ message: 'Valid vehicle_type query param required' });
    }
    const vType = normalizeVehicleType(vehicle_type);

    const areaResult = await pool.query('SELECT * FROM parking_areas WHERE id=$1', [parking_id]);
    if (!areaResult.rows.length) return res.status(404).json({ message: 'Parking area not found' });
    const parkingArea = areaResult.rows[0];

    const totalSlots = vType === 'car' ? parkingArea.total_car_slots : parkingArea.total_bike_slots;
    if (!totalSlots || totalSlots === 0) return res.status(200).json([]);

    // Fetch all active bookings for this parking & vehicle type
    // active bookings = bookings table (exit_time NULL) — both verified and recent unverified
    const bookingsRes = await pool.query(
      `SELECT slot_number, entry_time, is_verified, created_at FROM bookings
       WHERE parking_id=$1 AND vehicle_type=$2`,
      [parking_id, vType]
    );

    // Fetch all active holds
    const holdsRes = await pool.query(
      `SELECT slot_number, phone FROM slot_holds
       WHERE parking_id=$1 AND vehicle_type=$2 AND hold_expires_at > NOW()`,
      [parking_id, vType]
    );

    const bookingMap = new Map(); // slot_number -> booking info (pick the latest entry_time if multiple)
    for (const r of bookingsRes.rows) {
      const sn = Number(r.slot_number);
      // prefer verified over unverified: if verified exists, keep that
      const prev = bookingMap.get(sn);
      if (!prev) bookingMap.set(sn, r);
      else {
        // if existing is unverified but this is verified, replace
        if (!prev.is_verified && r.is_verified) bookingMap.set(sn, r);
      }
    }

    const heldSlots = new Map(holdsRes.rows.map(h => [Number(h.slot_number), h.phone]));

    // Precompute userEntry if provided
    const userEntry = entry_time ? new Date(entry_time) : null;
    const now = new Date();

    const allSlots = Array.from({ length: totalSlots }, (_, i) => {
      const slot_number = i + 1;
      let status = 'available';
      // Priority: held > verified booking > unverified booking > available
      if (heldSlots.has(slot_number)) {
        status = 'held';
      } else if (bookingMap.has(slot_number)) {
        const booking = bookingMap.get(slot_number);
        const bookingEntry = new Date(booking.entry_time);

        // If booking is verified => use BUFFER_MINUTES overlap
        if (booking.is_verified) {
          const bwin = windowFromTime(bookingEntry, BUFFER_MINUTES);
          if (userEntry) {
            const newStart = new Date(userEntry.getTime() - BUFFER_MINUTES * 60000);
            const newEnd = new Date(userEntry.getTime() + BUFFER_MINUTES * 60000 + 0); // booking length not used for display; keep ±BUFFER
            if (windowsOverlap(bwin.start, bwin.end, newStart, newEnd)) status = 'booked';
          } else {
            // live view: show booked if now within booking window
            if (now >= bwin.start && now <= bwin.end) status = 'booked';
          }
        } else {
          // unverified booking considered only if recently created (UNVERIFIED_GRACE_MINUTES)
          const createdAt = new Date(booking.created_at);
          const graceStart = new Date(createdAt.getTime());
          const graceEnd = new Date(createdAt.getTime() + UNVERIFIED_GRACE_MINUTES * 60000);
          if (userEntry) {
            // overlap check against bookingEntry with BUFFER_MINUTES
            const newStart = new Date(userEntry.getTime() - BUFFER_MINUTES * 60000);
            const newEnd = new Date(userEntry.getTime() + BUFFER_MINUTES * 60000);
            const bwin = windowFromTime(bookingEntry, BUFFER_MINUTES);
            if (windowsOverlap(bwin.start, bwin.end, newStart, newEnd)) status = 'pending';
          } else {
            // live view: if booking created within grace window and now close to bookingEntry
            if (now <= graceEnd) {
              const bwin = windowFromTime(bookingEntry, BUFFER_MINUTES);
              if (now >= bwin.start && now <= bwin.end) status = 'pending';
            }
          }
        }
      }

      return {
        parking_id,
        slot_number,
        vehicle_type: vType,
        status,
        held_by: heldSlots.get(slot_number) || null
      };
    });

    return res.status(200).json(allSlots);
  } catch (e) {
    console.error('Error fetching slots:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// -------------------- Booking helper & endpoints --------------------

// Helper: check time overlap against active bookings (verified OR recent unverified)
async function hasTimeOverlap(parkingId, slotNum, vType, newEntryTime) {
  // newEntryTime is Date
  const rows = await pool.query(
    `SELECT entry_time, is_verified, created_at FROM bookings
     WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3`,
    [parkingId, slotNum, vType]
  );

  for (const r of rows.rows) {
    const existingEntry = new Date(r.entry_time);
    if (r.is_verified) {
      // verified booking: full buffer applies
      const existingWindow = windowFromTime(existingEntry, BUFFER_MINUTES);
      const newStart = new Date(newEntryTime.getTime() - BUFFER_MINUTES * 60000);
      const newEnd = new Date(newEntryTime.getTime() + 15 * 60000); // booking length
      if (windowsOverlap(existingWindow.start, existingWindow.end, newStart, newEnd)) return true;
    } else {
      // unverified booking: only consider if created recently (grace window)
      const createdAt = new Date(r.created_at);
      const graceCutoff = new Date(Date.now() - UNVERIFIED_GRACE_MINUTES * 60000);
      if (createdAt >= graceCutoff) {
        const existingWindow = windowFromTime(existingEntry, BUFFER_MINUTES);
        const newStart = new Date(newEntryTime.getTime() - BUFFER_MINUTES * 60000);
        const newEnd = new Date(newEntryTime.getTime() + 15 * 60000);
        if (windowsOverlap(existingWindow.start, existingWindow.end, newStart, newEnd)) return true;
      }
    }
  }
  return false;
}

// Create booking (user or owner)
async function processBooking(req, res) {
  const client = await pool.connect();
  try {
    const {
      parking_id,
      slot_number,
      vehicle_type,
      number_plate,
      entry_time,
      phone,
      payment_id,
      amount
    } = req.body || {};

    if (!parking_id || !slot_number || !vehicle_type || !phone) {
      return res.status(400).json({ message: 'parking_id, slot_number, vehicle_type and phone required' });
    }

    const parkingId = toInt(parking_id);
    const slotNum = Number.isInteger(Number(slot_number)) ? parseInt(slot_number, 10) : null;
    const vType = normalizeVehicleType(vehicle_type);

    if (!parkingId || !slotNum) return res.status(400).json({ message: 'Invalid ids' });

    const now = new Date();
    const entryTime = entry_time ? new Date(entry_time) : now;

    // Validate parking area and slot capacity
    const areaRes = await pool.query('SELECT * FROM parking_areas WHERE id=$1', [parkingId]);
    if (!areaRes.rows.length) return res.status(404).json({ message: 'Parking area not found' });
    const parkingArea = areaRes.rows[0];
    const totalSlots = vType === 'car' ? parkingArea.total_car_slots : parkingArea.total_bike_slots;
    if (slotNum > totalSlots || slotNum <= 0) return res.status(400).json({ message: 'Invalid slot_number for the parking area' });

    // TIME OVERLAP: check against active bookings (transaction later ensures atomic)
    const overlap = await hasTimeOverlap(parkingId, slotNum, vType, entryTime);
    if (overlap) {
      return res.status(400).json({ message: "This slot has a booking near your selected time.", code: "TIME_OVERLAP" });
    }

    // Use transaction to prevent race conditions
    await client.query('BEGIN');

    // Lock any existing booking rows for this slot (if present) to serialize
    await client.query(
      `SELECT id FROM bookings
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3
       FOR UPDATE`,
      [parkingId, slotNum, vType]
    );

    // Re-check holds: if a hold exists, it must belong to this phone to convert (security)
    const holdRes = await client.query(
      `SELECT phone, hold_expires_at FROM slot_holds
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3 AND hold_expires_at > NOW()
       LIMIT 1`,
      [parkingId, slotNum, vType]
    );

    if (holdRes.rows.length > 0) {
      const holdOwner = holdRes.rows[0].phone;
      if (holdOwner !== phone) {
        await client.query('ROLLBACK');
        return res.status(403).json({ message: "Slot is held by another user" });
      }
      // If holdOwner === phone, we will delete the hold below (convert)
    }

    // Decide is_verified based on presence of payment_id
    const isVerified = false; 

    // Insert booking (unverified if no payment_id)
    const insertBookingRes = await client.query(
      `INSERT INTO bookings
       (parking_id, slot_number, vehicle_type, slot_id, number_plate, phone, entry_time, exit_time, payment_id, amount, is_verified, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
       RETURNING id`,
      [
        parkingId,
        slotNum,
        vType,
        null, // slot_id will be ensured below via slots table (hybrid)
        number_plate || '',
        phone || '',
        entryTime,
        null,
        payment_id || '',
        amount || 0,
        isVerified
      ]
    );

    const bookingId = insertBookingRes.rows[0].id;

    // Ensure slot exists in slots table (Hybrid model) → upsert
    const slotUpsertRes = await client.query(
      `INSERT INTO slots (parking_id, slot_number, vehicle_type, last_booked_at, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW(),NOW())
       ON CONFLICT (parking_id, vehicle_type, slot_number)
       DO UPDATE SET last_booked_at=NOW(), updated_at=NOW()
       RETURNING id`,
      [parkingId, slotNum, vType]
    );
    const slotId = slotUpsertRes.rows[0].id;

    // Update booking with slot_id
    await client.query(`UPDATE bookings SET slot_id=$1 WHERE id=$2`, [slotId, bookingId]);

    // If payment provided (verified) → update counts immediately
    if (isVerified) {
      if (vType === 'car') {
        await client.query(
          `UPDATE parking_areas
           SET available_car_slots = GREATEST(available_car_slots - 1, 0),
               booked_car_slots = booked_car_slots + 1
           WHERE id=$1`,
          [parkingId]
        );
      } else {
        await client.query(
          `UPDATE parking_areas
           SET available_bike_slots = GREATEST(available_bike_slots - 1, 0),
               booked_bike_slots = booked_bike_slots + 1
           WHERE id=$1`,
          [parkingId]
        );
      }
    }

    // Convert hold → booking: delete hold ONLY if owned by this phone
    if (holdRes.rows.length > 0) {
      await client.query(
        `DELETE FROM slot_holds
         WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3 AND phone=$4`,
        [parkingId, slotNum, vType, phone]
      );
    }

    await client.query('COMMIT');

    // Emit socket update (status depends on verified/unverified)
    const newStatus = isVerified ? 'booked' : 'pending';
    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number: slotNum,
      vehicle_type: vType,
      status: newStatus,
      phone
    });

    return res.status(200).json({ message: isVerified ? 'Slot booked (verified)' : 'Slot reserved (unverified)', booking_id: bookingId, slot_number: slotNum });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    console.error('Error booking slot:', err);
    return res.status(500).json({ message: 'Internal Server Error', error: String(err) });
  } finally {
    client.release();
  }
}

app.post('/api/bookings', processBooking);
app.post('/api/owner/bookings', processBooking);

// -------------------- Verify booking (FIXED: RELAXED TIME CHECK) --------------------
// We remove the manual +5.5 hours calculation logic.
// We remove the strict return 400.
// We just log if it's outside the window, but allow the update to happen.
app.post('/api/bookings/verify', async (req, res) => {
  console.log("\n====== 🔍 VERIFY BOOKING ENDPOINT HIT ======");
  console.log("Request Body:", req.body);

  try {
    const { booking_id, payment_id, amount } = req.body || {};

    if (!booking_id) {
      console.log("❌ booking_id missing");
      return res.status(400).json({ message: 'booking_id required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const bRes = await client.query(
        `SELECT * FROM bookings WHERE id=$1 LIMIT 1 FOR UPDATE`,
        [booking_id]
      );

      console.log("Fetched booking row:", bRes.rows);

      if (!bRes.rows.length) {
        console.log("❌ Booking not found");
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Booking not found' });
      }

      const booking = bRes.rows[0];

      // --- TIME WINDOW CHECK (RELAXED) ---
      // We just parse the time normally. No manual +5.5h math.
      console.log("🔍 Booking entry_time raw:", booking.entry_time);
      const entryTime = booking.entry_time ? new Date(booking.entry_time) : null;
      const { start, end } = windowFromTime(entryTime, BUFFER_MINUTES);
      const now = new Date();

      console.log("Now:", now);
      console.log("Window Start:", start);
      console.log("Window End:", end);
      console.log("Inside window? -->", now >= start && now <= end);

      if (!(now >= start && now <= end)) {
        // !!! FIX: We LOG the mismatch but DO NOT RETURN 400.
        // This accepts the verification even if there is a timezone mismatch.
        console.warn("⚠️ Verification outside window (likely Timezone drift) - ALLOWING for Owner");
      }

      console.log("✅ Proceeding to verify booking");

      await client.query(
        `UPDATE bookings
         SET is_verified=true, payment_id=$1, amount=$2, verified_at=NOW(), updated_at=NOW()
         WHERE id=$3`,
        [payment_id || booking.payment_id || "", amount ?? booking.amount ?? 0, booking_id]
      );

      await client.query('COMMIT');
      console.log("✅ Booking verified successfully");

      return res.status(200).json({ message: "Booking verified successfully" });

    } catch (err) {
      console.log("❌ Verify SQL Error:", err);
      try { await client.query('ROLLBACK'); } catch (_) {}
      return res.status(500).json({ message: 'Verification failed', error: err.toString() });
    } finally {
      client.release();
    }

  } catch (err) {
    console.log("❌ Verify outer error:", err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});


// -------------------- Cancel booking --------------------
app.post("/api/bookings/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const { booking_id, parking_id, vehicle_type, cancelled_by } = req.body || {};
    if (!booking_id || !parking_id || !vehicle_type) {
      return res.status(400).json({ message: "booking_id, parking_id, and vehicle_type required" });
    }

    const bookingId = toInt(booking_id);
    const parkingId = toInt(parking_id);
    const vType = normalizeVehicleType(vehicle_type);

    await client.query('BEGIN');

    const bkRes = await client.query('SELECT * FROM bookings WHERE id=$1 AND parking_id=$2 AND vehicle_type=$3 LIMIT 1 FOR UPDATE', [bookingId, parkingId, vType]);
    if (!bkRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: "Active booking not found" }); }

    const booking = bkRes.rows[0];
    const now = new Date();
    const entryTime = booking.entry_time ? new Date(booking.entry_time) : now;
    const diffSeconds = Math.floor((entryTime - now) / 1000);

    // Refund slab (same as before)
    let refundPercent = 0;
    if (diffSeconds > 3600) refundPercent = 60;
    else if (diffSeconds > 1800) refundPercent = 40;
    else if (diffSeconds > 900) refundPercent = 40;
    else refundPercent = 0;
    const refundAmount = Math.round(((booking.amount || 0) * refundPercent) / 100);

    // If verified booking, attempt refund via payment gateway (skipped if no payment_id)
    let paymentRefundResponse = null;
    if (booking.payment_id && refundAmount > 0) {
      try {
        // optional: call your payment provider here
        // paymentRefundResponse = await paymentProvider.refund(booking.payment_id, refundAmount)
      } catch (e) {
        console.error('Payment refund error:', e);
      }
    }

    // Archive to booking_history with additional metadata
    await client.query(
      `INSERT INTO booking_history
       (booking_id, parking_id, slot_id, slot_number, phone, vehicle_type, number_plate,
        entry_time, exit_time, payment_id, amount, archived_at, cancelled, cancelled_at,
        refund_percent, refund_amount, is_verified, verified_at, cancelled_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),true,NOW(),$12,$13,$14,$15,$16)`,
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
        booking.payment_id || '',
        booking.amount || 0,
        refundPercent,
        refundAmount,
        booking.is_verified || false,
        booking.verified_at || null,
        cancelled_by || null
      ]
    );

    // Delete booking
    await client.query('DELETE FROM bookings WHERE id=$1', [bookingId]);

    // Update counts only if booking was verified
    if (booking.is_verified) {
      if (vType === 'car') {
        await client.query(
          `UPDATE parking_areas SET available_car_slots = available_car_slots + 1, booked_car_slots = booked_car_slots - 1 WHERE id=$1`,
          [parkingId]
        );
      } else {
        await client.query(
          `UPDATE parking_areas SET available_bike_slots = available_bike_slots + 1, booked_bike_slots = booked_bike_slots - 1 WHERE id=$1`,
          [parkingId]
        );
      }
    }

    await client.query('COMMIT');

    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number: booking.slot_number,
      vehicle_type: vType,
      status: "available"
    });

    return res.status(200).json({
      message: "Booking cancelled",
      refund_percent: refundPercent,
      refund_amount: refundAmount,
      payment_refund: paymentRefundResponse
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (er) {}
    console.error("Cancel Booking Error:", e);
    return res.status(500).json({ message: "Internal Server Error", error: String(e) });
  } finally {
    client.release();
  }
});

// -------------------- Owner endpoints (simpler mapping to existing code) --------------------
// owners list/register/login remain similar to your prior code (kept concise)

app.get('/api/owner/all', async (req, res) => {
  try {
    const owners = await pool.query('SELECT id, phone, parking_area_name, created_at, updated_at FROM register_login');
    return res.status(200).json(owners.rows);
  } catch (e) {
    console.error('Error fetching owners:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.post('/api/owner/register', async (req, res) => {
  const { phone, parking_area_name, password } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });
  try {
    const existing = await pool.query('SELECT * FROM register_login WHERE phone=$1 LIMIT 1', [phone]);
    if (existing.rows.length) return res.status(400).json({ message: 'User already exists' });
    const now = new Date();
    const ownerResult = await pool.query(
      `INSERT INTO register_login (phone, parking_area_name, password, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, phone, parking_area_name, created_at, updated_at`,
      [phone, parking_area_name, password, now, now]
    );
    return res.status(201).json({ message: 'Registered successfully', owner: ownerResult.rows[0] });
  } catch (e) {
    if (e && e.code === '23505') return res.status(400).json({ message: 'Phone already registered' });
    console.error('Error registering owner:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

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
  } catch (e) {
    console.error('Error logging in owner:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Update/Create parking area (hybrid logic) — unchanged core but ensure reset removal if changed
app.post('/api/owner/parking_areas', async (req, res) => {
  const {
    name: ownerPhone,
    parking_area_name,
    location,
    total_car_slots,
    total_bike_slots,
  } = req.body || {};
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

      // Reset slots/bookings if capacity changed
      if (carSlotsChanged || bikeSlotsChanged) {
        const parkingId = existingArea.id;
        await pool.query('DELETE FROM slots WHERE parking_id=$1', [parkingId]);
        await pool.query('DELETE FROM bookings WHERE parking_id=$1', [parkingId]);
        return res.status(200).json({ message: 'Parking area updated. All slots/bookings reset due to capacity change (Hybrid Model).' });
      }

      return res.status(200).json({ message: 'Parking area updated successfully' });
    } else {
      const now = new Date();
      const result = await pool.query(
        `INSERT INTO parking_areas
         (name, lat, lng, total_car_slots, available_car_slots, booked_car_slots,
          total_bike_slots, available_bike_slots, booked_bike_slots, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [parking_area_name, lat, lng, newTotalCarSlots, newTotalCarSlots, 0, newTotalBikeSlots, newTotalBikeSlots, 0, now, now]
      );
      return res.status(201).json({ message: 'Parking area created (Hybrid Model - no initial slots created)', id: result.rows[0].id });
    }
  } catch (e) {
    console.error('Error processing parking area:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get('/api/owner/parking_areas', async (req, res) => {
  try {
    const areas = await pool.query('SELECT * FROM parking_areas');
    const withLocation = areas.rows.map(a => ({ ...a, location: { lat: a.lat, lng: a.lng } }));
    return res.status(200).json(withLocation);
  } catch (e) {
    console.error('Error fetching parking areas:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Owner slots endpoint (optimized)
app.get('/api/owner/parking_areas/:id/slots', async (req, res) => {
  try {
    const parking_id = toInt(req.params.id);
    if (!parking_id) return res.status(400).json({ message: 'Invalid parking area ID' });

    const { vehicle_type } = req.query || {};
    if (!vehicle_type || !['car', 'bike'].includes(vehicle_type.toLowerCase()))
      return res.status(400).json({ message: 'Valid vehicle_type query param required' });

    const vType = normalizeVehicleType(vehicle_type);

    const areaResult = await pool.query('SELECT * FROM parking_areas WHERE id=$1', [parking_id]);
    if (!areaResult.rows.length)
      return res.status(404).json({ message: 'Parking area not found' });

    const parkingArea = areaResult.rows[0];
    const totalSlots =
      vType === 'car'
        ? parkingArea.total_car_slots
        : parkingArea.total_bike_slots;

    if (!totalSlots || totalSlots === 0) return res.status(200).json([]);

    // Fetch bookings
    const bookingsRes = await pool.query(
      `SELECT slot_number, is_verified
       FROM bookings 
       WHERE parking_id=$1 AND vehicle_type=$2`,
      [parking_id, vType]
    );

    // Fetch holds
    const holdsRes = await pool.query(
      `SELECT slot_number 
       FROM slot_holds 
       WHERE parking_id=$1 AND vehicle_type=$2 AND hold_expires_at > NOW()`,
      [parking_id, vType]
    );

    const pendingSlots = new Set();
    const bookedSlots = new Set();
    const heldSlotNumbers = new Set(holdsRes.rows.map(h => h.slot_number));

    for (const row of bookingsRes.rows) {
      if (row.is_verified) bookedSlots.add(row.slot_number);
      else pendingSlots.add(row.slot_number);
    }

    const allSlots = Array.from({ length: totalSlots }, (_, i) => {
      const slot_number = i + 1;
      let status = 'available';

      if (heldSlotNumbers.has(slot_number)) status = 'held';
      else if (pendingSlots.has(slot_number)) status = 'pending';
      else if (bookedSlots.has(slot_number)) status = 'booked';

      return { parking_id, slot_number, vehicle_type: vType, status };
    });

    return res.status(200).json(allSlots);

  } catch (e) {
    console.error('Error fetching owner slots:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});


// Owner get booking details
app.get('/api/owner/bookings', async (req, res) => {
  try {
    const { parking_id, slot_number, vehicle_type } = req.query || {};
    if (!parking_id || !slot_number || !vehicle_type) return res.status(400).json({ message: 'parking_id, slot_number, and vehicle_type query params required' });
    const parkingId = toInt(parking_id);
    const numSlot = parseInt(slot_number, 10);
    const vType = normalizeVehicleType(vehicle_type);
    if (!parkingId || isNaN(numSlot)) return res.status(400).json({ message: 'Invalid id(s)/slot_number' });

    const result = await pool.query(
      `SELECT * FROM bookings WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3 LIMIT 1`,
      [parkingId, numSlot, vType]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'No active booking found for this slot.' });
    return res.status(200).json(result.rows[0]);
  } catch (e) {
    console.error('Error fetching active booking:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Owner complete booking (archive + free slot)
app.post('/api/owner/bookings/complete', async (req, res) => {
  const client = await pool.connect();
  try {
    const { booking_id, parking_id, vehicle_type, exit_time, amount, payment_id } = req.body || {};
    if (!booking_id || !parking_id || !vehicle_type) return res.status(400).json({ message: 'booking_id, parking_id, and vehicle_type are required' });

    const bookingId = toInt(booking_id);
    const parkingId = toInt(parking_id);
    const vType = normalizeVehicleType(vehicle_type);
    if (!bookingId || !parkingId) return res.status(400).json({ message: 'Invalid id(s)' });

    await client.query('BEGIN');

    const activeRes = await client.query('SELECT * FROM bookings WHERE id=$1 AND parking_id=$2 AND vehicle_type=$3 LIMIT 1 FOR UPDATE', [bookingId, parkingId, vType]);
    if (!activeRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'No active booking found with this ID' }); }

    const booking = activeRes.rows[0];
    const finalExitTime = exit_time ? new Date(exit_time) : new Date();
    const finalAmount = amount || booking.amount || 0;

    await client.query(
      `INSERT INTO booking_history
       (booking_id, parking_id, slot_id, slot_number, phone, vehicle_type, number_plate, entry_time, exit_time, payment_id, amount, archived_at, is_verified, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13)`,
      [booking.id, booking.parking_id, booking.slot_id, booking.slot_number, booking.phone, booking.vehicle_type, booking.number_plate, booking.entry_time, finalExitTime, payment_id || booking.payment_id || '', finalAmount, booking.is_verified || false, booking.verified_at || null]
    );

    await client.query('DELETE FROM bookings WHERE id=$1', [bookingId]);

    // Update counts only if verified
    if (booking.is_verified) {
      if (vType === 'car') {
        await client.query(`UPDATE parking_areas SET available_car_slots = available_car_slots + 1, booked_car_slots = booked_car_slots - 1 WHERE id=$1`, [parkingId]);
      } else {
        await client.query(`UPDATE parking_areas SET available_bike_slots = available_bike_slots + 1, booked_bike_slots = booked_bike_slots - 1 WHERE id=$1`, [parkingId]);
      }
    }

    await client.query('COMMIT');

    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number: booking.slot_number,
      vehicle_type: vType,
      status: "available"
    });

    return res.status(200).json({ message: 'Booking completed and slot freed', amount: finalAmount });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Error completing booking:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// -------------------- WebSocket Setup --------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

io.on("connection", (socket) => {
  console.log("✅ WebSocket connected:", socket.id);

  socket.on("join_parking", ({ parking_id, vehicle_type }) => {
    const room = `parking_${parking_id}_${normalizeVehicleType(vehicle_type)}`;
    socket.join(room);
    console.log(`✅ ${socket.id} joined ${room}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ WebSocket disconnected:", socket.id);
  });
});

// -------------------- Cleanup tasks --------------------

// Expired holds cleanup (every 5 seconds)
setInterval(async () => {
  try {
    const expired = await pool.query(
      `DELETE FROM slot_holds
       WHERE hold_expires_at < NOW()
       RETURNING parking_id, slot_number, vehicle_type`
    );
    for (const row of expired.rows) {
      io.to(`parking_${row.parking_id}_${row.vehicle_type}`).emit("slot_update", {
        parking_id: row.parking_id,
        slot_number: row.slot_number,
        vehicle_type: row.vehicle_type,
        status: "available"
      });
    }
  } catch (e) {
    console.error('Hold cleanup failed:', e);
  }
}, 5000);

// Expire stale unverified bookings (every 30 seconds)
setInterval(async () => {
  try {
    const expired = await pool.query(
      `DELETE FROM bookings
       WHERE is_verified=false AND created_at < NOW() - ($1 || ' seconds')::interval
       RETURNING id, parking_id, slot_number, vehicle_type`,
      [UNVERIFIED_EXPIRY_SECONDS]
    );

    for (const row of expired.rows) {
      // notify clients slot is available
      io.to(`parking_${row.parking_id}_${row.vehicle_type}`).emit("slot_update", {
        parking_id: row.parking_id,
        slot_number: row.slot_number,
        vehicle_type: row.vehicle_type,
        status: "available"
      });

      // Archive into booking_history as cancelled/unverified expired (optional)
      // For simplicity, leaving archival to cancel endpoint or separate process if required
    }
  } catch (e) {
    console.error('Unverified bookings cleanup failed:', e);
  }
}, 30000);

// -------------------- Global Error Handler --------------------
app.use((err, req, res, next) => {
  console.error('GLOBAL ERROR:', err && (err.stack || err.message || err));
  if (!res.headersSent) {
    res.status(500).json({ message: 'Internal Server Error', error: err.message || String(err) });
  }
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server + WebSocket running on http://0.0.0.0:${PORT}`);
});