const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const app = express();
const uri = "mongodb://localhost:27017";
const client = new MongoClient(uri);

app.use(express.json());
app.use(cors({ origin: '*' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure multer for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const extFiletypes = /\.jpeg|\.jpg|\.png/;
        const mimeFiletypes = /image\/(jpeg|png)/;
        const extname = extFiletypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = mimeFiletypes.test(file.mimetype.toLowerCase());
        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG/JPG/PNG images are allowed!'));
        }
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

// Database Connection with Retry
async function connectDB() {
    let retries = 5;
    while (retries) {
        try {
            await client.connect();
            console.log("Connected to MongoDB");
            return client.db("ParkingSystem");
        } catch (error) {
            console.error("MongoDB connection failed:", error);
            retries -= 1;
            if (retries === 0) {
                console.error("Max retries reached. Exiting...");
                process.exit(1);
            }
            console.log(`Retrying connection (${5 - retries}/5)...`);
            await new Promise(res => setTimeout(res, 2000));
        }
    }
}

const dbPromise = connectDB();

// --- USER APP ENDPOINTS ---

// User Registration Endpoint
app.post('/api/users/register', async (req, res) => {
    const { phone, name, car_number_plate, bike_number_plate } = req.body;
    const db = await dbPromise;

    try {
        const existingUser = await db.collection('users').findOne({ phone });
        if (existingUser) {
            return res.status(200).json({ message: "User already exists", user: existingUser });
        }

        const newUser = {
            phone,
            name: name || 'User',
            car_number_plate: car_number_plate || '',
            bike_number_plate: bike_number_plate || '',
            createdAt: new Date(),
        };
        await db.collection('users').insertOne(newUser);
        res.status(201).json({ message: "User registered successfully", user: newUser });
    } catch (error) {
        console.error("Error registering user:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// User Login Endpoint
app.post('/api/users/login', async (req, res) => {
    const { phone } = req.body;
    const db = await dbPromise;

    try {
        const user = await db.collection('users').findOne({ phone });
        if (!user) {
            return res.status(404).json({ message: "User not found. Please register." });
        }
        res.status(200).json({ message: "Login successful", user });
    } catch (error) {
        console.error("Error logging in user:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Get User Profile
app.get('/api/users/profile/:phone', async (req, res) => {
    const db = await dbPromise;
    const { phone } = req.params;

    try {
        const user = await db.collection('users').findOne({ phone });
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        res.status(200).json(user);
    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Update User Profile Endpoint
app.put('/api/users/profile', async (req, res) => {
    const { phone, name, car_number_plate, bike_number_plate } = req.body;
    const db = await dbPromise;

    try {
        const result = await db.collection('users').updateOne(
            { phone },
            {
                $set: {
                    name,
                    car_number_plate,
                    bike_number_plate,
                    updatedAt: new Date(),
                },
            }
        );
        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "User not found" });
        }
        const updatedUser = await db.collection('users').findOne({ phone });
        res.status(200).json({ message: "Profile updated successfully", user: updatedUser });
    } catch (error) {
        console.error("Error updating user profile:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Get User Bookings
app.get('/api/users/bookings/:phone', async (req, res) => {
    const db = await dbPromise;
    const { phone } = req.params;

    try {
        const bookings = await db.collection('bookings').find({ phone }).sort({ entry_time: -1 }).toArray();
        const populatedBookings = await Promise.all(bookings.map(async (booking) => {
            const parkingArea = await db.collection('parking_areas').findOne({ _id: booking.parking_id });
            const slot = await db.collection('slots').findOne({ _id: booking.slot_id });
            return {
                ...booking,
                location: parkingArea ? parkingArea.name : 'Unknown Location',
                slot_number: slot ? slot.slot_number : 'Unknown Slot',
            };
        }));
        res.status(200).json(populatedBookings);
    } catch (error) {
        console.error("Error fetching user bookings:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Get All Parking Areas
app.get('/api/parking_areas', async (req, res) => {
    const db = await dbPromise;

    try {
        const parkingAreas = await db.collection('parking_areas').find().toArray();
        res.status(200).json(parkingAreas);
    } catch (error) {
        console.error("Error fetching parking areas:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Get Parking Area Details by ID for User App
app.get('/api/parking_areas/:id', async (req, res) => {
    const db = await dbPromise;
    const parkingId = req.params.id;

    if (!ObjectId.isValid(parkingId)) {
        return res.status(400).json({ message: "Invalid parking area ID" });
    }

    try {
        const parkingArea = await db.collection('parking_areas').findOne({ _id: new ObjectId(parkingId) });
        if (!parkingArea) {
            return res.status(404).json({ message: "Parking area not found" });
        }
        res.status(200).json(parkingArea);
    } catch (error) {
        console.error("Error fetching parking area details:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Get All Slots for a Parking Area for User App
app.get('/api/parking_areas/:id/slots', async (req, res) => {
    const db = await dbPromise;
    const { vehicle_type } = req.query;

    try {
        const parkingId = new ObjectId(req.params.id);
        const query = { parking_id: parkingId };
        if (vehicle_type) query.vehicle_type = vehicle_type.toLowerCase();

        const slots = await db.collection('slots').find(query).toArray();
        const activeBookings = await db.collection('bookings')
            .find({ parking_id: parkingId, status: "active" })
            .toArray();
        const bookedSlotIds = activeBookings.map(b => b.slot_id.toString());

        const slotsWithStatus = slots.map(slot => ({
            ...slot,
            is_booked: bookedSlotIds.includes(slot._id.toString()),
        }));

        res.status(200).json(slotsWithStatus);
    } catch (error) {
        console.error("Error fetching slots:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Book a Slot for User App
app.post('/api/bookings', async (req, res) => {
    const { parking_id, slot_id, vehicle_type, number_plate, entry_time, phone } = req.body;
    const db = await dbPromise;

    try {
        const slot = await db.collection('slots').findOne({ _id: new ObjectId(slot_id) });
        if (!slot || slot.status !== "available") {
            return res.status(400).json({ message: "Slot not available" });
        }

        const booking = {
            parking_id: new ObjectId(parking_id),
            slot_id: new ObjectId(slot_id),
            vehicle_type: vehicle_type.toLowerCase(),
            number_plate,
            phone,
            entry_time: new Date(entry_time),
            status: "active",
            createdAt: new Date(),
        };
        const result = await db.collection('bookings').insertOne(booking);

        await db.collection('slots').updateOne(
            { _id: new ObjectId(slot_id) },
            { $set: { status: "booked", current_booking_id: result.insertedId } }
        );

        const updateField = vehicle_type.toLowerCase() === "car"
            ? { $inc: { available_car_slots: -1, booked_car_slots: 1 } }
            : { $inc: { available_bike_slots: -1, booked_bike_slots: 1 } };
        await db.collection('parking_areas').updateOne(
            { _id: new ObjectId(parking_id) },
            updateField
        );

        res.status(200).json({
            message: "Slot booked",
            booking_id: result.insertedId,
            slot_number: slot.slot_number,
        });
    } catch (error) {
        console.error("Error booking slot:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// --- OWNER APP ENDPOINTS ---

// Register Parking Area Owner
app.post('/api/owner/register', async (req, res) => {
    const { phone, parking_area_name, password } = req.body;
    const db = await dbPromise;

    try {
        const existingUser = await db.collection('register_login').findOne({ phone });
        if (existingUser) {
            return res.status(400).json({ message: "User already exists" });
        }

        const user = {
            phone,
            parking_area_name,
            password,
            createdAt: new Date(),
        };
        await db.collection('register_login').insertOne(user);
        res.status(200).json({ message: "Registered successfully" });
    } catch (error) {
        console.error("Error registering owner:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Login Parking Area Owner
app.post('/api/owner/login', async (req, res) => {
    const { phone, password } = req.body;
    const db = await dbPromise;

    try {
        const user = password
            ? await db.collection('register_login').findOne({ phone, password })
            : await db.collection('register_login').findOne({ phone });
        if (!user) {
            return res.status(400).json({ message: "Invalid credentials" });
        }
        res.status(200).json({
            message: "Login successful",
            phone: user.phone,
            parking_area_name: user.parking_area_name,
        });
    } catch (error) {
        console.error("Error logging in owner:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Update or Create Parking Area
app.post('/api/owner/parking_areas', async (req, res) => {
    const { name, parking_area_name, location, total_car_slots, total_bike_slots } = req.body;
    const db = await dbPromise;

    try {
        const existingArea = await db.collection('parking_areas').findOne({ name: parking_area_name });

        if (existingArea) {
            const currentCarSlots = existingArea.total_car_slots;
            const currentBikeSlots = existingArea.total_bike_slots;
            const carSlotsChanged = total_car_slots !== currentCarSlots;
            const bikeSlotsChanged = total_bike_slots !== currentBikeSlots;

            await db.collection('parking_areas').updateOne(
                { name: parking_area_name },
                {
                    $set: {
                        location: { lat: location.lat, lng: location.lng },
                        total_car_slots,
                        total_bike_slots,
                        updatedAt: new Date(),
                    },
                }
            );

            await db.collection('register_login').updateOne(
                { phone: name },
                { $set: { parking_area_name, updatedAt: new Date() } }
            );

            if (carSlotsChanged || bikeSlotsChanged) {
                const parkingId = existingArea._id;
                await db.collection('slots').deleteMany({ parking_id: parkingId });

                const newCarSlots = Array.from({ length: total_car_slots }, (_, i) => ({
                    parking_id: parkingId,
                    slot_number: i + 1,
                    vehicle_type: "car",
                    status: "available",
                    current_booking_id: null,
                }));

                const newBikeSlots = Array.from({ length: total_bike_slots }, (_, i) => ({
                    parking_id: parkingId,
                    slot_number: i + 1,
                    vehicle_type: "bike",
                    status: "available",
                    current_booking_id: null,
                }));

                await db.collection('slots').insertMany([...newCarSlots, ...newBikeSlots]);

                await db.collection('parking_areas').updateOne(
                    { _id: parkingId },
                    {
                        $set: {
                            available_car_slots: total_car_slots,
                            booked_car_slots: 0,
                            available_bike_slots: total_bike_slots,
                            booked_bike_slots: 0,
                        },
                    }
                );
            }
            res.status(200).json({ message: "Parking area updated successfully" });
        } else {
            const parkingArea = {
                name: parking_area_name,
                location: { lat: location.lat, lng: location.lng },
                total_car_slots,
                available_car_slots: total_car_slots,
                booked_car_slots: 0,
                total_bike_slots,
                available_bike_slots: total_bike_slots,
                booked_bike_slots: 0,
                createdAt: new Date(),
            };
            const result = await db.collection('parking_areas').insertOne(parkingArea);

            await db.collection('register_login').updateOne(
                { phone: name },
                { $set: { parking_area_name, updatedAt: new Date() } }
            );

            const carSlots = Array.from({ length: total_car_slots }, (_, i) => ({
                parking_id: result.insertedId,
                slot_number: i + 1,
                vehicle_type: "car",
                status: "available",
                current_booking_id: null,
            }));
            const bikeSlots = Array.from({ length: total_bike_slots }, (_, i) => ({
                parking_id: result.insertedId,
                slot_number: i + 1,
                vehicle_type: "bike",
                status: "available",
                current_booking_id: null,
            }));
            await db.collection('slots').insertMany([...carSlots, ...bikeSlots]);

            res.status(200).json({ message: "Parking area created", id: result.insertedId });
        }
    } catch (error) {
        console.error("Error processing parking area:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Get Parking Areas for Owner
app.get('/api/owner/parking_areas', async (req, res) => {
    const db = await dbPromise;
    try {
        const parkingAreas = await db.collection('parking_areas').find().toArray();
        res.status(200).json(parkingAreas);
    } catch (error) {
        console.error("Error fetching parking areas:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Get Slots for a Parking Area for Owner
app.get('/api/owner/parking_areas/:id/slots', async (req, res) => {
    const db = await dbPromise;
    const { vehicle_type } = req.query;
    try {
        const parkingId = new ObjectId(req.params.id);
        const query = { parking_id: parkingId };
        if (vehicle_type) query.vehicle_type = vehicle_type.toLowerCase();
        const slots = await db.collection('slots').find(query).toArray();
        const activeBookings = await db.collection('bookings')
            .find({ parking_id: parkingId, status: "active" })
            .toArray();
        const bookedSlotIds = activeBookings.map(b => b.slot_id.toString());
        const slotsWithStatus = slots.map(slot => ({
            ...slot,
            is_booked: bookedSlotIds.includes(slot._id.toString()),
        }));
        res.status(200).json(slotsWithStatus);
    } catch (error) {
        console.error("Error fetching slots:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Book a Slot for Owner
app.post('/api/owner/bookings', async (req, res) => {
    const { parking_id, slot_id, vehicle_type, number_plate, entry_time, phone } = req.body;
    const db = await dbPromise;

    try {
        const slot = await db.collection('slots').findOne({ _id: new ObjectId(slot_id) });
        if (!slot || slot.status !== "available") {
            return res.status(400).json({ message: "Slot not available" });
        }
        const booking = {
            parking_id: new ObjectId(parking_id),
            slot_id: new ObjectId(slot_id),
            vehicle_type: vehicle_type.toLowerCase(),
            number_plate,
            phone,
            entry_time: new Date(entry_time),
            status: "active",
            createdAt: new Date(),
        };
        const result = await db.collection('bookings').insertOne(booking);
        await db.collection('slots').updateOne(
            { _id: new ObjectId(slot_id) },
            { $set: { status: "booked", current_booking_id: result.insertedId } }
        );
        const updateField = vehicle_type.toLowerCase() === "car"
            ? { $inc: { available_car_slots: -1, booked_car_slots: 1 } }
            : { $inc: { available_bike_slots: -1, booked_bike_slots: 1 } };
        await db.collection('parking_areas').updateOne(
            { _id: new ObjectId(parking_id) },
            updateField
        );
        res.status(200).json({
            message: "Slot booked",
            booking_id: result.insertedId,
            slot_number: slot.slot_number,
        });
    } catch (error) {
        console.error("Error booking slot:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Get Booking Details for Owner
app.get('/api/owner/bookings', async (req, res) => {
    const { slot_id } = req.query;
    const db = await dbPromise;
    try {
        const bookings = await db.collection('bookings').find({
            slot_id: new ObjectId(slot_id),
            status: "active",
        }).toArray();
        res.status(200).json(bookings);
    } catch (error) {
        console.error("Error fetching bookings:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Complete a Booking and Free the Slot for Owner
app.post('/api/owner/bookings/complete', async (req, res) => {
    const { slot_id, parking_id, vehicle_type, exit_time, amount } = req.body;
    const db = await dbPromise;
    try {
        const bookingUpdateResult = await db.collection('bookings').updateOne(
            { slot_id: new ObjectId(slot_id), status: "active" },
            {
                $set: {
                    status: "completed",
                    exit_time: new Date(exit_time),
                    amount: amount,
                    updatedAt: new Date(),
                },
            }
        );
        if (bookingUpdateResult.matchedCount === 0) {
            return res.status(400).json({ message: "No active booking found" });
        }
        await db.collection('slots').updateOne(
            { _id: new ObjectId(slot_id) },
            { $set: { status: "available", current_booking_id: null } }
        );
        const updateField = vehicle_type.toLowerCase() === "car"
            ? { $inc: { available_car_slots: 1, booked_car_slots: -1 } }
            : { $inc: { available_bike_slots: 1, booked_bike_slots: -1 } };
        await db.collection('parking_areas').updateOne(
            { _id: new ObjectId(parking_id) },
            updateField
        );
        res.status(200).json({ message: "Booking completed and slot freed" });
    } catch (error) {
        console.error("Error completing booking:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});
app.get('/api/users/all', async (req, res) => {
    const db = await dbPromise;

    try {
        const users = await db.collection('users').find().toArray();
        res.status(200).json(users);
    } catch (error) {
        console.error("Error fetching all users:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});
// Start Server
//app.listen(3000, () => console.log("Server running on port 3000"));
app.listen(3000, '0.0.0.0', () => {
    console.log("Server running on http://0.0.0.0:3000");
});
