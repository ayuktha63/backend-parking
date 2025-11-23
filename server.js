// Fixed and cleaned server.js
// Key fixes applied:
// - Ensure every response is JSON
// - Global error handler to avoid empty responses
// - Validate ObjectId inputs
// - Handle duplicate key (11000) errors on inserts
// - Consistent status codes
// - Minor cleanup and comments

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const app = express();

// ====== USE MONGODB ATLAS HERE ======
const uri = "mongodb+srv://ayuktha:ayuktha123@parking.eaisuau.mongodb.net/?appName=Parking";
const client = new MongoClient(uri, {
    tls: true,
    tlsAllowInvalidCertificates: false,
    minDHSize: 1024,
    useUnifiedTopology: true,
    retryWrites: true,
    serverApi: { version: "1" },
});

// ====================================

app.use(express.json());
app.use(cors({ origin: '*' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Force JSON content-type for all responses (helps clients that expect JSON)
app.use((req, res, next) => {
    // Don't override if another handler already set a different content-type (static files etc.)
    if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json');
    }
    next();
});

// Configure multer for file uploads (left available in case used later)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const extFiletypes = /\.(jpeg|jpg|png)$/i;
        const mimeFiletypes = /image\/(jpeg|png)/i;
        const extname = extFiletypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = mimeFiletypes.test(file.mimetype.toLowerCase());
        if (extname && mimetype) cb(null, true);
        else cb(new Error('Only JPEG/JPG/PNG images are allowed!'));
    }
});

// Multer Error Handling Middleware
function handleMulterError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ message: err.message });
    } else if (err) {
        return res.status(400).json({ message: err.message });
    }
    next();
}

// ====== CONNECT TO ATLAS DB WITH RETRIES ======
async function connectDB() {
    let retries = 5;
    while (retries) {
        try {
            await client.connect();
            console.log('Connected to MongoDB Atlas');
            return client.db('ParkingSystem');
        } catch (error) {
            console.error('MongoDB Atlas connection failed:', error.message || error);
            retries -= 1;
            if (retries === 0) {
                console.error('Max retries reached. Exiting...');
                process.exit(1);
            }
            console.log(`Retrying connection (${5 - retries}/5)...`);
            await new Promise(res => setTimeout(res, 2000));
        }
    }
}
const dbPromise = connectDB();

// Helper: safe ObjectId cast
function toObjectIdOrNull(id) {
    try {
        if (!id) return null;
        return ObjectId.isValid(id) ? new ObjectId(id) : null;
    } catch (e) {
        return null;
    }
}

// --- USER APP ENDPOINTS ---

// User Registration Endpoint
app.post('/api/users/register', async (req, res, next) => {
    const { phone, name, car_number_plate, bike_number_plate } = req.body || {};

    if (!phone) return res.status(400).json({ message: 'phone is required' });

    try {
        const db = await dbPromise;
        const existingUser = await db.collection('users').findOne({ phone });
        if (existingUser) {
            return res.status(200).json({ message: 'User already exists', user: existingUser });
        }

        const newUser = {
            phone,
            name: name || 'User',
            car_number_plate: car_number_plate || '',
            bike_number_plate: bike_number_plate || '',
            createdAt: new Date(),
        };

        const result = await db.collection('users').insertOne(newUser);
        // Return the stored document (with _id)
        const saved = await db.collection('users').findOne({ _id: result.insertedId });
        return res.status(201).json({ message: 'User registered successfully', user: saved });
    } catch (error) {
        // Handle duplicate key (race) explicitly
        if (error && error.code === 11000) {
            return res.status(400).json({ message: 'Phone already registered' });
        }
        console.error('Error registering user:', error.message || error);
        return next(error);
    }
});

// User Login Endpoint
app.post('/api/users/login', async (req, res, next) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ message: 'phone is required' });

    try {
        const db = await dbPromise;
        const user = await db.collection('users').findOne({ phone });
        if (!user) return res.status(404).json({ message: 'User not found. Please register.' });
        return res.status(200).json({ message: 'Login successful', user });
    } catch (error) {
        console.error('Error logging in user:', error.message || error);
        return next(error);
    }
});

// Get User Profile
app.get('/api/users/profile/:phone', async (req, res, next) => {
    try {
        const { phone } = req.params || {};
        if (!phone) return res.status(400).json({ message: 'phone is required' });
        const db = await dbPromise;
        const user = await db.collection('users').findOne({ phone });
        if (!user) return res.status(404).json({ message: 'User not found' });
        return res.status(200).json(user);
    } catch (error) {
        console.error('Error fetching user profile:', error.message || error);
        return next(error);
    }
});

// Get User Bookings
app.get('/api/users/bookings/:phone', async (req, res, next) => {
    try {
        const { phone } = req.params || {};
        if (!phone) return res.status(400).json({ message: 'phone is required' });
        const db = await dbPromise;
        const bookings = await db.collection('bookings').find({ phone }).sort({ entry_time: -1 }).toArray();
        const populatedBookings = await Promise.all(bookings.map(async (booking) => {
            const parkingArea = booking.parking_id ? await db.collection('parking_areas').findOne({ _id: booking.parking_id }) : null;
            const slot = booking.slot_id ? await db.collection('slots').findOne({ _id: booking.slot_id }) : null;
            return {
                ...booking,
                location: parkingArea ? parkingArea.name : 'Unknown Location',
                slot_number: slot ? slot.slot_number : 'Unknown Slot',
            };
        }));
        return res.status(200).json(populatedBookings);
    } catch (error) {
        console.error('Error fetching user bookings:', error.message || error);
        return next(error);
    }
});

// Get All Parking Areas
app.get('/api/parking_areas', async (req, res, next) => {
    try {
        const db = await dbPromise;
        const parkingAreas = await db.collection('parking_areas').find().toArray();
        return res.status(200).json(parkingAreas);
    } catch (error) {
        console.error('Error fetching parking areas:', error.message || error);
        return next(error);
    }
});

// Get Parking Area Details by ID for User App
app.get('/api/parking_areas/:id', async (req, res, next) => {
    try {
        const parkingId = req.params.id;
        const oid = toObjectIdOrNull(parkingId);
        if (!oid) return res.status(400).json({ message: 'Invalid parking area ID' });
        const db = await dbPromise;
        const parkingArea = await db.collection('parking_areas').findOne({ _id: oid });
        if (!parkingArea) return res.status(404).json({ message: 'Parking area not found' });
        return res.status(200).json(parkingArea);
    } catch (error) {
        console.error('Error fetching parking area details:', error.message || error);
        return next(error);
    }
});

// Get All Slots for a Parking Area for User App
app.get('/api/parking_areas/:id/slots', async (req, res, next) => {
    try {
        const parkingId = req.params.id;
        const oid = toObjectIdOrNull(parkingId);
        if (!oid) return res.status(400).json({ message: 'Invalid parking area ID' });
        const db = await dbPromise;
        const { vehicle_type } = req.query || {};
        const query = { parking_id: oid };
        if (vehicle_type) query.vehicle_type = vehicle_type.toLowerCase();

        const slots = await db.collection('slots').find(query).toArray();
        const activeBookings = await db.collection('bookings').find({ parking_id: oid, status: 'active' }).toArray();
        const bookedSlotIds = activeBookings.map(b => (b.slot_id ? b.slot_id.toString() : ''));
        const slotsWithStatus = slots.map(slot => ({ ...slot, is_booked: bookedSlotIds.includes(slot._id.toString()) }));
        return res.status(200).json(slotsWithStatus);
    } catch (error) {
        console.error('Error fetching slots:', error.message || error);
        return next(error);
    }
});

// Book a Slot for User App
app.post('/api/bookings', async (req, res, next) => {
    try {
        const { parking_id, slot_id, vehicle_type, number_plate, entry_time, phone } = req.body || {};
        if (!parking_id || !slot_id || !vehicle_type) return res.status(400).json({ message: 'parking_id, slot_id and vehicle_type are required' });
        const db = await dbPromise;
        const slotOid = toObjectIdOrNull(slot_id);
        if (!slotOid) return res.status(400).json({ message: 'Invalid slot_id' });
        const slot = await db.collection('slots').findOne({ _id: slotOid });
        if (!slot || slot.status !== 'available') return res.status(400).json({ message: 'Slot not available' });

        const booking = {
            parking_id: toObjectIdOrNull(parking_id) || null,
            slot_id: slotOid,
            vehicle_type: vehicle_type.toLowerCase(),
            number_plate: number_plate || '',
            phone: phone || '',
            entry_time: entry_time ? new Date(entry_time) : new Date(),
            status: 'active',
            createdAt: new Date(),
        };
        const result = await db.collection('bookings').insertOne(booking);
        await db.collection('slots').updateOne({ _id: slotOid }, { $set: { status: 'booked', current_booking_id: result.insertedId } });

        const updateField = booking.vehicle_type === 'car'
            ? { $inc: { available_car_slots: -1, booked_car_slots: 1 } }
            : { $inc: { available_bike_slots: -1, booked_bike_slots: 1 } };

        if (booking.parking_id) {
            await db.collection('parking_areas').updateOne({ _id: booking.parking_id }, updateField);
        }

        return res.status(200).json({ message: 'Slot booked', booking_id: result.insertedId, slot_number: slot.slot_number });
    } catch (error) {
        console.error('Error booking slot:', error.message || error);
        return next(error);
    }
});

// --- OWNER APP ENDPOINTS ---

// Get All Parking Area Owners
app.get('/api/owner/all', async (req, res, next) => {
    try {
        const db = await dbPromise;
        const owners = await db.collection('register_login').find({}, { projection: { password: 0 } }).toArray();
        return res.status(200).json(owners);
    } catch (error) {
        console.error('Error fetching all owners:', error.message || error);
        return next(error);
    }
});

// Register Parking Area Owner
app.post('/api/owner/register', async (req, res, next) => {
    const { phone, parking_area_name, password } = req.body || {};
    if (!phone) return res.status(400).json({ message: 'phone is required' });

    try {
        const db = await dbPromise;
        const existingUser = await db.collection('register_login').findOne({ phone });
        if (existingUser) return res.status(400).json({ message: 'User already exists' });

        const user = { phone, parking_area_name, password, createdAt: new Date() };
        const result = await db.collection('register_login').insertOne(user);
        const saved = await db.collection('register_login').findOne({ _id: result.insertedId });
        // hide password in response
        if (saved) {
            delete saved.password;
        }
        return res.status(201).json({ message: 'Registered successfully', owner: saved });
    } catch (error) {
        if (error && error.code === 11000) return res.status(400).json({ message: 'Phone already registered' });
        console.error('Error registering owner:', error.message || error);
        return next(error);
    }
});

// Login Parking Area Owner
app.post('/api/owner/login', async (req, res, next) => {
    try {
        const { phone, password } = req.body || {};
        if (!phone) return res.status(400).json({ message: 'phone is required' });
        const db = await dbPromise;
        const user = password
            ? await db.collection('register_login').findOne({ phone, password })
            : await db.collection('register_login').findOne({ phone });
        if (!user) return res.status(400).json({ message: 'Invalid credentials' });
        return res.status(200).json({ message: 'Login successful', phone: user.phone, parking_area_name: user.parking_area_name });
    } catch (error) {
        console.error('Error logging in owner:', error.message || error);
        return next(error);
    }
});

// Update or Create Parking Area
app.post('/api/owner/parking_areas', async (req, res, next) => {
    const { name, parking_area_name, location, total_car_slots, total_bike_slots } = req.body || {};
    if (!name) return res.status(400).json({ message: 'owner phone (name) is required' });
    if (!parking_area_name) return res.status(400).json({ message: 'parking_area_name is required' });

    try {
        const db = await dbPromise;
        const existingArea = await db.collection('parking_areas').findOne({ name: parking_area_name });

        if (existingArea) {
            const currentCarSlots = existingArea.total_car_slots;
            const currentBikeSlots = existingArea.total_bike_slots;
            const carSlotsChanged = typeof total_car_slots === 'number' && total_car_slots !== currentCarSlots;
            const bikeSlotsChanged = typeof total_bike_slots === 'number' && total_bike_slots !== currentBikeSlots;

            await db.collection('parking_areas').updateOne({ name: parking_area_name }, { $set: { location: { lat: location?.lat, lng: location?.lng }, total_car_slots, total_bike_slots, updatedAt: new Date() } });

            await db.collection('register_login').updateOne({ phone: name }, { $set: { parking_area_name, updatedAt: new Date() } });

            if (carSlotsChanged || bikeSlotsChanged) {
                const parkingId = existingArea._id;
                await db.collection('slots').deleteMany({ parking_id: parkingId });

                const newCarSlots = Array.from({ length: total_car_slots }, (_, i) => ({ parking_id: parkingId, slot_number: i + 1, vehicle_type: 'car', status: 'available', current_booking_id: null }));
                const newBikeSlots = Array.from({ length: total_bike_slots }, (_, i) => ({ parking_id: parkingId, slot_number: i + 1, vehicle_type: 'bike', status: 'available', current_booking_id: null }));

                if (newCarSlots.length) await db.collection('slots').insertMany(newCarSlots);
                if (newBikeSlots.length) await db.collection('slots').insertMany(newBikeSlots);

                await db.collection('parking_areas').updateOne({ _id: parkingId }, { $set: { available_car_slots: total_car_slots, booked_car_slots: 0, available_bike_slots: total_bike_slots, booked_bike_slots: 0 } });
            }
            return res.status(200).json({ message: 'Parking area updated successfully' });
        } else {
            const parkingArea = { name: parking_area_name, location: { lat: location?.lat, lng: location?.lng }, total_car_slots, available_car_slots: total_car_slots, booked_car_slots: 0, total_bike_slots, available_bike_slots: total_bike_slots, booked_bike_slots: 0, createdAt: new Date() };
            const result = await db.collection('parking_areas').insertOne(parkingArea);

            await db.collection('register_login').updateOne({ phone: name }, { $set: { parking_area_name, updatedAt: new Date() } });

            const carSlots = Array.from({ length: total_car_slots }, (_, i) => ({ parking_id: result.insertedId, slot_number: i + 1, vehicle_type: 'car', status: 'available', current_booking_id: null }));
            const bikeSlots = Array.from({ length: total_bike_slots }, (_, i) => ({ parking_id: result.insertedId, slot_number: i + 1, vehicle_type: 'bike', status: 'available', current_booking_id: null }));
            if (carSlots.length) await db.collection('slots').insertMany(carSlots);
            if (bikeSlots.length) await db.collection('slots').insertMany(bikeSlots);

            return res.status(201).json({ message: 'Parking area created', id: result.insertedId });
        }
    } catch (error) {
        console.error('Error processing parking area:', error.message || error);
        return next(error);
    }
});

// Get Parking Areas for Owner
app.get('/api/owner/parking_areas', async (req, res, next) => {
    try {
        const db = await dbPromise;
        const parkingAreas = await db.collection('parking_areas').find().toArray();
        return res.status(200).json(parkingAreas);
    } catch (error) {
        console.error('Error fetching parking areas:', error.message || error);
        return next(error);
    }
});

// Get Slots for a Parking Area for Owner
app.get('/api/owner/parking_areas/:id/slots', async (req, res, next) => {
    try {
        const parkingId = req.params.id;
        const oid = toObjectIdOrNull(parkingId);
        if (!oid) return res.status(400).json({ message: 'Invalid parking area ID' });
        const db = await dbPromise;
        const { vehicle_type } = req.query || {};
        const query = { parking_id: oid };
        if (vehicle_type) query.vehicle_type = vehicle_type.toLowerCase();

        const slots = await db.collection('slots').find(query).toArray();
        const activeBookings = await db.collection('bookings').find({ parking_id: oid, status: 'active' }).toArray();
        const bookedSlotIds = activeBookings.map(b => (b.slot_id ? b.slot_id.toString() : ''));
        const slotsWithStatus = slots.map(slot => ({ ...slot, is_booked: bookedSlotIds.includes(slot._id.toString()) }));
        return res.status(200).json(slotsWithStatus);
    } catch (error) {
        console.error('Error fetching slots:', error.message || error);
        return next(error);
    }
});

// Book a Slot for Owner
app.post('/api/owner/bookings', async (req, res, next) => {
    try {
        const { parking_id, slot_id, vehicle_type, number_plate, entry_time, phone } = req.body || {};
        if (!parking_id || !slot_id || !vehicle_type) return res.status(400).json({ message: 'parking_id, slot_id and vehicle_type are required' });
        const db = await dbPromise;
        const slotOid = toObjectIdOrNull(slot_id);
        if (!slotOid) return res.status(400).json({ message: 'Invalid slot_id' });
        const slot = await db.collection('slots').findOne({ _id: slotOid });
        if (!slot || slot.status !== 'available') return res.status(400).json({ message: 'Slot not available' });

        const booking = {
            parking_id: toObjectIdOrNull(parking_id) || null,
            slot_id: slotOid,
            vehicle_type: vehicle_type.toLowerCase(),
            number_plate: number_plate || '',
            phone: phone || '',
            entry_time: entry_time ? new Date(entry_time) : new Date(),
            status: 'active',
            createdAt: new Date(),
        };
        const result = await db.collection('bookings').insertOne(booking);
        await db.collection('slots').updateOne({ _id: slotOid }, { $set: { status: 'booked', current_booking_id: result.insertedId } });

        const updateField = booking.vehicle_type === 'car'
            ? { $inc: { available_car_slots: -1, booked_car_slots: 1 } }
            : { $inc: { available_bike_slots: -1, booked_bike_slots: 1 } };

        if (booking.parking_id) {
            await db.collection('parking_areas').updateOne({ _id: booking.parking_id }, updateField);
        }

        return res.status(200).json({ message: 'Slot booked', booking_id: result.insertedId, slot_number: slot.slot_number });
    } catch (error) {
        console.error('Error booking slot (owner):', error.message || error);
        return next(error);
    }
});

// Get Booking Details for Owner
app.get('/api/owner/bookings', async (req, res, next) => {
    try {
        const { slot_id } = req.query || {};
        if (!slot_id) return res.status(400).json({ message: 'slot_id query param required' });
        const db = await dbPromise;
        const oid = toObjectIdOrNull(slot_id);
        if (!oid) return res.status(400).json({ message: 'Invalid slot_id' });
        const bookings = await db.collection('bookings').find({ slot_id: oid, status: 'active' }).toArray();
        return res.status(200).json(bookings);
    } catch (error) {
        console.error('Error fetching bookings:', error.message || error);
        return next(error);
    }
});

// Complete a Booking and Free the Slot for Owner
app.post('/api/owner/bookings/complete', async (req, res, next) => {
    try {
        const { slot_id, parking_id, vehicle_type, exit_time, amount } = req.body || {};
        if (!slot_id || !parking_id) return res.status(400).json({ message: 'slot_id and parking_id are required' });
        const db = await dbPromise;
        const slotOid = toObjectIdOrNull(slot_id);
        const parkingOid = toObjectIdOrNull(parking_id);
        if (!slotOid || !parkingOid) return res.status(400).json({ message: 'Invalid id(s)' });

        const bookingUpdateResult = await db.collection('bookings').updateOne({ slot_id: slotOid, status: 'active' }, { $set: { status: 'completed', exit_time: exit_time ? new Date(exit_time) : new Date(), amount: amount || 0, updatedAt: new Date() } });
        if (bookingUpdateResult.matchedCount === 0) return res.status(400).json({ message: 'No active booking found' });

        await db.collection('slots').updateOne({ _id: slotOid }, { $set: { status: 'available', current_booking_id: null } });
        const updateField = vehicle_type && vehicle_type.toLowerCase() === 'car' ? { $inc: { available_car_slots: 1, booked_car_slots: -1 } } : { $inc: { available_bike_slots: 1, booked_bike_slots: -1 } };
        await db.collection('parking_areas').updateOne({ _id: parkingOid }, updateField);

        return res.status(200).json({ message: 'Booking completed and slot freed' });
    } catch (error) {
        console.error('Error completing booking:', error.message || error);
        return next(error);
    }
});

// Get All Users (admin)
app.get('/api/users/all', async (req, res, next) => {
    try {
        const db = await dbPromise;
        const users = await db.collection('users').find().toArray();
        return res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching all users:', error.message || error);
        return next(error);
    }
});

// GLOBAL ERROR HANDLER (must be after routes)
app.use((err, req, res, next) => {
    console.error('GLOBAL ERROR:', err && (err.stack || err.message || err));
    if (!res.headersSent) {
        // ensure JSON
        res.status(500).json({ message: 'Internal Server Error', error: err.message || String(err) });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
