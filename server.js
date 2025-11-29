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
const axios = require("axios");
const http = require('http'); // ✅ NEW
const { Server } = require('socket.io'); // ✅ NEW
const app = express();
const MSG91_AUTHKEY = "479720ASlYGogHXyXJ692aaeabP1";         // <-- paste your MSG91 auth key
const WA_TEMPLATE_NAME = "transactional";
const WA_NAMESPACE = "5b1a5f70_3016_4451_8747_6fa69b8b564a";
const WA_INTEGRATED_NUMBER = "15558692939";
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

// ====== NEON POSTGRES CONNECTION (NO .env) ======
const pool = new Pool({
  connectionString:
    'postgresql://neondb_owner:npg_5x4ADLWqziOR@ep-lucky-water-adryg5p6-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
});

// Helper: safe int cast
function toInt(id) {
  const num = Number(id);
  return Number.isInteger(num) ? num : null;
}
app.post("/api/auth/send-otp", async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ message: "Phone is required" });
  }

  // Generate OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  // Store OTP temporarily
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
                  "value": otp   // <-- OTP goes here
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


// 📌 VERIFY OTP
app.post("/api/auth/verify-otp", async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp)
    return res.status(400).json({ message: "Phone & OTP required" });

  const store = req.app.locals.otpStore;
  const realOtp = store[phone];

  if (!realOtp) {
    return res.status(400).json({ message: "OTP expired or not found" });
  }

  if (realOtp !== otp) {
    return res.status(400).json({ message: "Invalid OTP" });
  }

  // OTP verified → Remove from store
  delete store[phone];

  return res.status(200).json({ message: "OTP verified successfully" });
});
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
// Hold a slot temporarily (2–3 min reservation lock)
app.post('/api/holds', async (req, res) => {
  try {
    const { parking_id, slot_number, vehicle_type, phone } = req.body || {};
    if (!parking_id || !slot_number || !vehicle_type) {
      return res.status(400).json({
        message: "parking_id, slot_number & vehicle_type required"
      });
    }

    const parkingId = toInt(parking_id);
    const vType = vehicle_type.toLowerCase();

    // ✅ Check if already booked
    // Check time-window (only block if inside ±10 min window)
const booked = await pool.query(
  `SELECT entry_time FROM bookings 
   WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3`,
  [parkingId, slot_number, vType]
);

let isBlocked = false;

if (booked.rows.length > 0) {
  const entry = new Date(booked.rows[0].entry_time);

  const existingStart = new Date(entry.getTime() - 10 * 60000);
  const existingEnd = new Date(entry.getTime() + 10 * 60000);
  const now = new Date();

  if (now >= existingStart && now <= existingEnd) {
    isBlocked = true;
  }
}

if (isBlocked) {
  return res.status(400).json({ message: "Slot currently in active window" });
}


    // ✅ Check existing valid hold
    const existingHold = await pool.query(
      `SELECT 1 FROM slot_holds
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3
       AND hold_expires_at > NOW()`,
      [parkingId, slot_number, vType]
    );
    if (existingHold.rows.length > 0) {
      return res.status(400).json({ message: "Slot already held" });
    }

    // ✅ Create new hold for 2 minutes
    await pool.query(
      `INSERT INTO slot_holds
       (parking_id, slot_number, vehicle_type, phone, hold_expires_at)
       VALUES ($1,$2,$3,$4,NOW() + INTERVAL '20 seconds')`,
      [parkingId, slot_number, vType, phone || ""]
    );

    // ✅ Emit update to both apps
    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number,
      vehicle_type: vType,
      status: "held",
      phone 

    });

    return res.status(200).json({
      message: "Slot temporarily held",
      slot_number,
      expires_in_sec: 20
    });
  } catch (e) {
    console.error("Error creating hold:", e);
    return res.status(500).json({ message: "Internal server error" });
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

    // ✅ FROM HERE — ADD HELD LOGIC
const activeHolds = await pool.query(
  `SELECT slot_number FROM slot_holds
   WHERE parking_id=$1 AND vehicle_type=$2
   AND hold_expires_at > NOW()`,
  [parking_id, vType]
);

const heldSlotNumbers = new Set(activeHolds.rows.map(h => h.slot_number));

const allSlots = [];

for (let i = 1; i <= totalSlots; i++) {
  const slot_number = i;

  let status = "available";

  // FETCH EXISTING BOOKING FOR THIS SLOT
  const existingBooking = await pool.query(
    `SELECT entry_time FROM bookings
     WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3
     LIMIT 1`,
    [parking_id, slot_number, vType]
  );

  if (existingBooking.rows.length > 0) {
    const entry = new Date(existingBooking.rows[0].entry_time);

    // ACTIVE WINDOW CHECK (use seconds in test mode)
    const existingStart = new Date(entry.getTime() - 10 * 60000);
    const existingEnd = new Date(entry.getTime() + 10 * 60000);

    const userEntry = req.query.entry_time ? new Date(req.query.entry_time) : null;

if (userEntry) {
    const userEnd = new Date(userEntry.getTime() + 15 * 60000);

    // Check overlap
    if (userEntry < existingEnd && userEnd > existingStart) {
        status = "booked";
    }
} else {
    // Fallback: show booked only if NOW is in buffer
    const now = new Date();
    if (now >= existingStart && now <= existingEnd) {
        status = "booked";
    }
}

  }

  // HELD CHECK (HIGHEST PRIORITY)
  if (heldSlotNumbers.has(slot_number)) {
    status = "held";
  }

  allSlots.push({
    parking_id,
    slot_number,
    vehicle_type: vType,
    status,
  });
}

// ✅ TO HERE


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
      payment_id,
    } = req.body || {};

    const parkingId = toInt(parking_id);
    const slotNum = Number.isInteger(Number(slot_number)) ? parseInt(slot_number, 10) : null;

    if (!parkingId || !slotNum || !vehicle_type) {
      return res
        .status(400)
        .json({ message: 'parking_id, slot_number and vehicle_type are required' });
    }

    const vType = vehicle_type.toLowerCase();

    // Debugging log (remove in production)
    console.log('processBooking called:', {
      parkingId, slotNum, vType, number_plate, entry_time, phone, payment_id
    });

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

    if (slotNum > totalSlots || slotNum <= 0) {
      return res
        .status(400)
        .json({ message: 'Invalid slot_number for the parking area' });
    }

    // Check if already booked (use slotNum)
    // ⚠️ NEW: TIME OVERLAP CHECK
// new booking start time
const newStart = new Date(entry_time);
const newEnd = new Date(newStart.getTime() + 15 * 60000);  // +15 minutes

// Fetch existing active bookings for this slot
const conflicts = await pool.query(
  `SELECT entry_time FROM bookings
   WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3`,
  [parkingId, slotNum, vType]
);

for (const row of conflicts.rows) {
  const existing = new Date(row.entry_time);

  const existingStart = new Date(existing.getTime() - 10 * 60000); // -10 min
  const existingEnd = new Date(existing.getTime() + 10 * 60000);   // +10 min

  // Overlap condition
  if (newStart < existingEnd && newEnd > existingStart) {
    return res.status(400).json({
      message: "This slot has a booking near your selected time.",
      code: "TIME_OVERLAP"
    });
  }
}

// ORIGINAL CHECK
const existingActiveBooking = await pool.query(
  `SELECT 1 FROM bookings
   WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3`,
  [parkingId, slotNum, vType]
);



    // Remove existing hold for this slot (convert hold → booking)
    await pool.query(
      `DELETE FROM slot_holds
       WHERE parking_id=$1 AND slot_number=$2 AND vehicle_type=$3`,
      [parkingId, slotNum, vType]
    );

    // HYBRID MODEL — ensure slot entry exists (use slotNum)
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

    // Create confirmed booking — IMPORTANT: include payment_id here
const bookingAmount = req.body.amount || 0;

const bookingResult = await pool.query(
  `INSERT INTO bookings
   (parking_id, slot_id, slot_number, vehicle_type, number_plate, phone,
    entry_time, exit_time, payment_id, amount, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
    bookingAmount,     // ⭐ NEW ⭐
    now,
    now,
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

    // Real-time update via WebSocket
    io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
      parking_id: parkingId,
      slot_number: slotNum,
      vehicle_type: vType,
      status: "booked",
      phone
    });

    // Debug success
    console.log('Booking created id=', bookingResult.rows[0].id);

    return res.status(200).json({
      message: 'Slot booked successfully',
      booking_id: bookingResult.rows[0].id,
      slot_number: slotNum,
    });
  } catch (error) {
    console.error('Error booking slot:', error);
    // Return the error message in dev mode to help debugging (optional)
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
}



// Book a Slot for User App
app.post('/api/bookings', processBooking);

// ===============================================
// NEW: USER CANCEL BOOKING (Refund Logic)
// ===============================================
app.post("/api/bookings/cancel", async (req, res) => {
  try {
    const { booking_id, parking_id, vehicle_type } = req.body || {};
    if (!booking_id || !parking_id || !vehicle_type) {
      return res.status(400).json({
        message: "booking_id, parking_id, and vehicle_type required",
      });
    }

    const bookingId = toInt(booking_id);
    const parkingId = toInt(parking_id);
    const vType = vehicle_type.toLowerCase();

    // Fetch active booking
    const bkRes = await pool.query(
      `SELECT * FROM bookings
       WHERE id=$1 AND parking_id=$2 AND vehicle_type=$3 LIMIT 1`,
      [bookingId, parkingId, vType]
    );

    if (!bkRes.rows.length) {
      return res.status(404).json({ message: "Active booking not found" });
    }

    const booking = bkRes.rows[0];
    const now = new Date();
    const entryTime = new Date(booking.entry_time);

    const diffSeconds = Math.floor((entryTime - now) / 1000);

    // Refund slab
    let refundPercent = 0;
    if (diffSeconds > 3600) refundPercent = 60;
    else if (diffSeconds > 1800) refundPercent = 40;
    else if (diffSeconds > 900) refundPercent = 40;
    else refundPercent = 0;

    const refundAmount = Math.round(
      ((booking.amount || 0) * refundPercent) / 100
    );

    // Razorpay refund (optional)
    let razorRefund = null;
    if (refundAmount > 0 && booking.payment_id) {
      try {
        razorRefund = await razorpay.payments.refund(booking.payment_id, {
          amount: refundAmount,
        });
      } catch (e) {
        console.error("Razorpay refund error:", e);
      }
    }

    // Archive into history (map VALUES EXACTLY)
    await pool.query(
  `INSERT INTO booking_history
  (booking_id, parking_id, slot_id, slot_number,
   phone, vehicle_type, number_plate, entry_time,
   exit_time, payment_id, amount, archived_at,
   cancelled, cancelled_at, refund_percent, refund_amount)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),true,NOW(),$12,$13)`,
  [
    booking.id,               // $1
    booking.parking_id,       // $2
    booking.slot_id,          // $3
    booking.slot_number,      // $4
    booking.phone,            // $5
    booking.vehicle_type,     // $6
    booking.number_plate,     // $7
    booking.entry_time,       // $8
    now,                      // $9 exit_time
    booking.payment_id || "", // $10
    booking.amount || 0,      // $11 amount
    refundPercent,            // $12 refund_percent
    refundAmount              // $13 refund_amount
  ]
);



    // Delete booking
    await pool.query(`DELETE FROM bookings WHERE id=$1`, [bookingId]);

    // Update slot counters
    if (vType === "car") {
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

    // WebSocket notify
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

    // ✅ FROM HERE — ADD HELD LOGIC
const activeHolds = await pool.query(
  `SELECT slot_number FROM slot_holds
   WHERE parking_id=$1 AND vehicle_type=$2
   AND hold_expires_at > NOW()`,
  [parking_id, vType]
);

const heldSlotNumbers = new Set(activeHolds.rows.map(h => h.slot_number));

const allSlots = Array.from({ length: totalSlots }, (_, i) => {
  const slot_number = i + 1;

  let status = "available";
  if (bookedSlotNumbers.has(slot_number)) status = "booked";
  else if (heldSlotNumbers.has(slot_number)) status = "held";

  return {
    parking_id,
    slot_number,
    vehicle_type: vType,
    status,
  };
});
// ✅ TO HERE


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

    // ✅ Real-time free-slot update
io.to(`parking_${parkingId}_${vType}`).emit("slot_update", {
  parking_id: parkingId,
  slot_number: activeBooking.slot_number,
  vehicle_type: vType,
  status: "available",
});

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

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  }
});

// ✅ WebSocket listeners here
io.on("connection", (socket) => {
  console.log("✅ WebSocket connected:", socket.id);

  socket.on("join_parking", ({ parking_id, vehicle_type }) => {
    const room = `parking_${parking_id}_${vehicle_type.toLowerCase()}`; // ✅ lowercase
    socket.join(room);
    console.log(`✅ ${socket.id} joined ${room}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ WebSocket disconnected:", socket.id);
  });
});


const PORT = process.env.PORT || 3000;
// ✅ FROM HERE — Auto cleanup expired holds
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
}, 2000);

// ✅ TO HERE

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server + WebSocket running on http://0.0.0.0:${PORT}`);
});