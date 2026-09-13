'use strict';

/**
 * Socket.IO gateway.
 *
 * Two changes from the previous implementation:
 *
 *   1. Rooms are authorised. Any client could previously `join_parking` for any lot
 *      and watch live occupancy — including customer phone numbers, which were
 *      included in every hold and booking event.
 *   2. Payloads carry no PII. Slot updates describe a slot, not a person. Whether a
 *      hold is yours is expressed as `held_by_you`, resolved per-socket.
 *
 * The instance is created once at boot and reached through `getIo()`, so modules
 * can emit without importing the HTTP server.
 */

const { config } = require('../config');
const { logger } = require('../utils/logger');
const { verifyAccessToken } = require('../middleware/auth');

let io = null;

/** Room name for a lot + vehicle type. One definition, used by every emitter. */
function parkingRoom(parkingAreaId, vehicleType) {
  return `parking:${parkingAreaId}:${String(vehicleType || '').toLowerCase()}`;
}

/**
 * Lot-wide room, receiving every slot update regardless of vehicle type.
 *
 * The customer app watches one type at a time — it is booking one car. An operator
 * looking at their whole facility needs both, and subscribing to two per-type rooms
 * is not possible because `parking:subscribe` deliberately leaves the previous one
 * to stop subscriptions accumulating.
 */
function parkingAreaRoom(parkingAreaId) {
  return `parking:${parkingAreaId}:all`;
}

/** Per-user room, for booking-status updates addressed to one person. */
function userRoom(userId) {
  return `user:${userId}`;
}

function ownerRoom(ownerId) {
  return `owner:${ownerId}`;
}

/**
 * Attaches Socket.IO to an HTTP server.
 * @param {import('http').Server} httpServer
 */
function attach(httpServer) {
  // eslint-disable-next-line global-require
  const { Server } = require('socket.io');

  io = new Server(httpServer, {
    cors: {
      origin: config.server.corsOrigins.includes('*') ? true : config.server.corsOrigins,
      methods: ['GET', 'POST'],
    },
    // Native clients connect over websocket directly; polling is kept as a fallback
    // for web builds behind restrictive proxies.
    transports: ['websocket', 'polling'],
    pingTimeout: 25_000,
  });

  /**
   * Handshake authentication.
   *
   * Anonymous sockets are allowed — the slot map is public information and the
   * customer app subscribes before a user necessarily has a session. What anonymous
   * sockets cannot do is join a user or owner room.
   */
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      socket.data.auth = null;
      return next();
    }

    try {
      const claims = verifyAccessToken(token);
      socket.data.auth = { id: Number(claims.sub), role: claims.role, phone: claims.phone };
    } catch {
      socket.data.auth = null;
    }
    return next();
  });

  io.on('connection', (socket) => {
    const auth = socket.data.auth;
    logger.debug({ socketId: socket.id, actor: auth ? `${auth.role}:${auth.id}` : 'anonymous' }, 'Socket connected');

    // Private rooms are joined automatically from verified claims, never from a
    // client-supplied id.
    if (auth?.role === 'customer') socket.join(userRoom(auth.id));
    if (auth?.role === 'owner') socket.join(ownerRoom(auth.id));

    socket.on('parking:subscribe', (payload, ack) => {
      const parkingAreaId = Number(payload?.parking_area_id ?? payload?.parking_id);
      const vehicleType = String(payload?.vehicle_type || '').toLowerCase();

      if (!Number.isInteger(parkingAreaId) || !['car', 'bike', 'all'].includes(vehicleType)) {
        return typeof ack === 'function'
          ? ack({ ok: false, error: 'parking_area_id and vehicle_type are required' })
          : undefined;
      }

      // Leave any previously-subscribed parking room, so toggling vehicle type does
      // not accumulate subscriptions and deliver duplicate events — a real defect in
      // the operator app, which joined a new room on every switch and never left.
      for (const room of socket.rooms) {
        if (typeof room === 'string' && room.startsWith('parking:')) socket.leave(room);
      }

      // `vehicle_type: 'all'` joins the lot-wide room instead of a per-type one.
      const room =
        vehicleType === 'all'
          ? parkingAreaRoom(parkingAreaId)
          : parkingRoom(parkingAreaId, vehicleType);

      socket.join(room);
      logger.debug({ socketId: socket.id, room }, 'Socket subscribed to parking');
      return typeof ack === 'function' ? ack({ ok: true, room }) : undefined;
    });

    socket.on('parking:unsubscribe', (payload, ack) => {
      const parkingAreaId = Number(payload?.parking_area_id ?? payload?.parking_id);
      const vehicleType = String(payload?.vehicle_type || '').toLowerCase();

      socket.leave(
        vehicleType === 'all'
          ? parkingAreaRoom(parkingAreaId)
          : parkingRoom(parkingAreaId, vehicleType)
      );
      return typeof ack === 'function' ? ack({ ok: true }) : undefined;
    });

    /** Legacy event name, kept so already-shipped app builds keep receiving updates. */
    socket.on('join_parking', (payload, ack) => {
      const parkingAreaId = Number(payload?.parking_id);
      const vehicleType = String(payload?.vehicle_type || '').toLowerCase();
      if (!Number.isInteger(parkingAreaId) || !['car', 'bike'].includes(vehicleType)) return;
      socket.join(parkingRoom(parkingAreaId, vehicleType));
      // Legacy room name, matching what the deployed backend emitted to.
      socket.join(`parking_${parkingAreaId}_${vehicleType}`);
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'Socket disconnected');
    });
  });

  logger.info('Socket.IO gateway attached');
  return io;
}

function getIo() {
  return io;
}

/**
 * Broadcasts a slot state change.
 *
 * `held_by_phone` is accepted for the legacy payload only and is never sent to
 * modern subscribers. New clients receive `held_by_you`, computed per socket.
 */
function emitSlotUpdate({
  parkingAreaId,
  vehicleType,
  slotId,
  slotNumber,
  slotCode,
  status,
  heldByUserId = null,
  expiresAt = null,
}) {
  if (!io) return;

  const rooms = [parkingRoom(parkingAreaId, vehicleType), parkingAreaRoom(parkingAreaId)];
  const base = {
    parking_area_id: parkingAreaId,
    vehicle_type: vehicleType,
    slot_id: slotId,
    slot_code: slotCode,
    slot_number: slotNumber,
    status,
    expires_at: expiresAt,
  };

  // Modern event: each socket is told only whether the hold is its own.
  //
  // Delivered per-socket rather than per-room because `held_by_you` differs by
  // recipient. A socket in both the per-type and the lot-wide room must still
  // receive exactly one copy, hence the seen set.
  const delivered = new Set();
  for (const room of rooms) {
    for (const socketId of io.sockets.adapter.rooms.get(room) || []) {
      if (delivered.has(socketId)) continue;
      delivered.add(socketId);

      const s = io.sockets.sockets.get(socketId);
      if (!s) continue;
      s.emit('slot:update', {
        ...base,
        held_by_you: Boolean(heldByUserId) && s.data.auth?.id === heldByUserId,
      });
    }
  }

  // Legacy event, for already-shipped builds. Kept payload-compatible.
  io.to(`parking_${parkingAreaId}_${vehicleType}`).emit('slot_update', {
    parking_id: parkingAreaId,
    vehicle_type: vehicleType,
    slot_number: slotNumber,
    status,
  });
}

/** Booking status change, addressed to the customer who owns it. */
function emitBookingUpdate(userId, booking) {
  if (!io || !userId) return;
  io.to(userRoom(userId)).emit('booking:update', booking);
}

/**
 * A hold expired, addressed to the customer who had it.
 *
 * The countdown on the device is driven from the server's `expires_at`, but a
 * device that is backgrounded or has a stalled timer would otherwise sit on a slot
 * it no longer holds. This is the authoritative "it's gone".
 */
function emitHoldExpired(userId, payload) {
  if (!io || !userId) return;
  io.to(userRoom(userId)).emit('hold:expired', payload);
}

/**
 * A lot's configuration changed — price, hours, amenities, capacity.
 *
 * Broadcast to the lot's rooms rather than to one operator, because the audience is
 * everyone currently looking at that lot: a second operator on the configuration
 * screen, and customers whose discovery results are now stale.
 *
 * Carries WHAT changed, never the new values. A client that acted on values from a
 * socket payload would be treating an event as the source of truth; the contract is
 * that an event invalidates and the API answers.
 */
function emitParkingConfigChanged(parkingAreaId, payload) {
  if (!io || !parkingAreaId) return;

  const rooms = [
    parkingAreaRoom(parkingAreaId),
    parkingRoom(parkingAreaId, 'car'),
    parkingRoom(parkingAreaId, 'bike'),
  ];

  for (const room of rooms) {
    io.to(room).emit('parking:config', { parking_area_id: parkingAreaId, ...payload });
  }
}

/** New or changed booking, addressed to the operator of the lot. */
function emitOwnerBookingUpdate(ownerId, payload) {
  if (!io || !ownerId) return;
  io.to(ownerRoom(ownerId)).emit('owner:booking', payload);
}

async function close() {
  if (!io) return;
  await new Promise((resolve) => io.close(resolve));
  io = null;
}

module.exports = {
  attach,
  getIo,
  close,
  parkingRoom,
  parkingAreaRoom,
  userRoom,
  ownerRoom,
  emitSlotUpdate,
  emitBookingUpdate,
  emitHoldExpired,
  emitOwnerBookingUpdate,
  emitParkingConfigChanged,
};
