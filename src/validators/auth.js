'use strict';

const { z, phone, otpCode, label } = require('./common');

/** POST /api/v1/auth/otp/request */
const requestOtp = {
  body: z.object({
    phone,
    role: z.enum(['customer', 'owner']).default('customer'),
  }),
};

/** POST /api/v1/auth/otp/verify */
const verifyOtp = {
  body: z.object({
    phone,
    otp: otpCode,
    request_id: z.string().uuid('Invalid request id'),
    // Optional profile captured during first-run, so a new user is not bounced
    // back to a second screen just to supply a name.
    name: z.string().trim().min(1).max(80).optional(),
    device_label: label,
  }),
};

/** POST /api/v1/auth/refresh */
const refresh = {
  body: z.object({
    refresh_token: z.string().trim().min(20, 'Invalid refresh token'),
  }),
};

/** POST /api/v1/auth/logout */
const logout = {
  body: z
    .object({
      refresh_token: z.string().trim().min(20).optional(),
      // Signs the account out everywhere, not just on this device.
      all_devices: z.boolean().default(false),
    })
    .default({}),
};

/**
 * POST /api/v1/auth/owner/password
 *
 * Password sign-in is retained for owners who already have one, but it is no longer
 * the only path, and there is no password-optional branch: the previous
 * implementation returned an account for `{phone}` alone, which the owner app's
 * profile screen actively relied on.
 */
const ownerPasswordLogin = {
  body: z.object({
    phone,
    password: z.string().min(1, 'Password is required').max(200),
    device_label: label,
  }),
};

/** POST /api/v1/auth/owner/password/set — requires an authenticated owner */
const setOwnerPassword = {
  body: z
    .object({
      current_password: z.string().max(200).optional(),
      new_password: z
        .string()
        .min(8, 'Use at least 8 characters')
        .max(200, 'That password is too long')
        .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), {
          message: 'Include at least one letter and one number',
        }),
    })
    .strict(),
};

/** PATCH /api/v1/me */
const updateMe = {
  body: z
    .object({
      name: z.string().trim().min(1, 'Name cannot be empty').max(80).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' }),
};

module.exports = {
  requestOtp,
  verifyOtp,
  refresh,
  logout,
  ownerPasswordLogin,
  setOwnerPassword,
  updateMe,
};
