'use strict';

/**
 * Auth HTTP layer.
 *
 * Controllers do three things and nothing else: read the validated request, call a
 * service, shape the response. No SQL, no business rules, no try/catch — errors
 * propagate to the shared error handler, which is the only place that decides what
 * a client is allowed to see.
 */

const authService = require('../services/authService');
const userRepository = require('../repositories/userRepository');
const ownerRepository = require('../repositories/ownerRepository');
const { notFound } = require('../utils/errors');

/** Wraps an async handler so rejections reach Express's error pipeline. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const requestOtp = asyncHandler(async (req, res) => {
  const { phone, role } = req.body;
  const result = await authService.requestOtp({
    phone,
    role,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.status(200).json({ data: result });
});

const verifyOtp = asyncHandler(async (req, res) => {
  const { phone, otp, request_id: requestId, name, device_label: deviceLabel } = req.body;
  // The role is fixed by which OTP purpose the code was issued against, so a code
  // requested for a customer cannot be redeemed for an operator session.
  const role = req.path.includes('/owner') ? 'owner' : 'customer';

  const result = await authService.verifyOtp({
    phone,
    otp,
    requestId,
    name,
    role,
    deviceLabel,
  });
  res.status(200).json({ data: result });
});

const ownerPasswordLogin = asyncHandler(async (req, res) => {
  const { phone, password, device_label: deviceLabel } = req.body;
  const result = await authService.ownerPasswordLogin({ phone, password, deviceLabel });
  res.status(200).json({ data: result });
});

const setOwnerPassword = asyncHandler(async (req, res) => {
  const { current_password: currentPassword, new_password: newPassword } = req.body;
  const result = await authService.setOwnerPassword({
    ownerId: req.auth.id,
    currentPassword,
    newPassword,
  });
  res.status(200).json({ data: result });
});

const refresh = asyncHandler(async (req, res) => {
  const { refresh_token: refreshToken } = req.body;
  const result = await authService.refresh({
    refreshToken,
    deviceLabel: req.get('user-agent')?.slice(0, 60),
  });
  res.status(200).json({ data: result });
});

const logout = asyncHandler(async (req, res) => {
  const { refresh_token: refreshToken, all_devices: allDevices } = req.body || {};
  await authService.logout({ refreshToken, allDevices, auth: req.auth });
  res.status(204).send();
});

/** GET /api/v1/me — the caller's own profile. */
const me = asyncHandler(async (req, res) => {
  if (req.auth.role === 'owner') {
    const owner = await ownerRepository.findById(req.auth.id);
    if (!owner) throw notFound('Account not found', 'ACCOUNT_MISSING');
    const parkingAreas = await ownerRepository.listParkingAreas(req.auth.id);
    return res.json({
      data: {
        owner: authService.serializeSubject(owner, 'owner'),
        parking_areas: parkingAreas.map((a) => ({ id: a.id, name: a.name, is_active: a.is_active })),
      },
    });
  }

  const user = await userRepository.findById(req.auth.id);
  if (!user) throw notFound('Account not found', 'ACCOUNT_MISSING');
  const vehicles = await userRepository.listVehicles(req.auth.id);

  return res.json({
    data: {
      user: authService.serializeSubject(user, 'customer'),
      vehicles: vehicles.map(serializeVehicle),
    },
  });
});

/**
 * PATCH /api/v1/me
 *
 * The endpoint the customer app's Settings screen has always called as
 * `PUT /api/users/profile`, which the live backend never implemented — so "Edit
 * Name" has never worked in production.
 */
const updateMe = asyncHandler(async (req, res) => {
  const { name } = req.body;

  if (req.auth.role === 'owner') {
    const owner = await ownerRepository.updateProfile(req.auth.id, { name });
    if (!owner) throw notFound('Account not found', 'ACCOUNT_MISSING');
    return res.json({ data: { owner: authService.serializeSubject(owner, 'owner') } });
  }

  const user = await userRepository.updateProfile(req.auth.id, { name });
  if (!user) throw notFound('Account not found', 'ACCOUNT_MISSING');
  return res.json({ data: { user: authService.serializeSubject(user, 'customer') } });
});

const listSessions = asyncHandler(async (req, res) => {
  const sessions = await authService.getSessions(req.auth);
  res.json({
    data: sessions.map((s) => ({
      id: s.id,
      device: s.device_label,
      created_at: s.created_at,
      last_used_at: s.last_used_at,
      expires_at: s.expires_at,
    })),
  });
});

/* ── vehicles ──────────────────────────────────────────────────────────────── */

function serializeVehicle(v) {
  return {
    id: v.id,
    vehicle_type: v.vehicle_type,
    number_plate: v.number_plate,
    label: v.label,
    is_default: v.is_default,
  };
}

const listVehicles = asyncHandler(async (req, res) => {
  const vehicles = await userRepository.listVehicles(req.auth.id);
  res.json({ data: vehicles.map(serializeVehicle) });
});

const addVehicle = asyncHandler(async (req, res) => {
  const { vehicle_type: vehicleType, number_plate: numberPlate, label, is_default: isDefault } =
    req.body;
  const vehicle = await userRepository.addVehicle(req.auth.id, {
    vehicleType,
    numberPlate,
    label,
    isDefault,
  });
  res.status(201).json({ data: serializeVehicle(vehicle) });
});

const setDefaultVehicle = asyncHandler(async (req, res) => {
  const vehicle = await userRepository.setDefaultVehicle(req.auth.id, req.params.vehicleId);
  if (!vehicle) throw notFound('Vehicle not found', 'VEHICLE_NOT_FOUND');
  res.json({ data: serializeVehicle(vehicle) });
});

const deleteVehicle = asyncHandler(async (req, res) => {
  const removed = await userRepository.deleteVehicle(req.auth.id, req.params.vehicleId);
  if (!removed) throw notFound('Vehicle not found', 'VEHICLE_NOT_FOUND');
  res.status(204).send();
});

module.exports = {
  asyncHandler,
  requestOtp,
  verifyOtp,
  ownerPasswordLogin,
  setOwnerPassword,
  refresh,
  logout,
  me,
  updateMe,
  listSessions,
  listVehicles,
  addVehicle,
  setDefaultVehicle,
  deleteVehicle,
  serializeVehicle,
};
