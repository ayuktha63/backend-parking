'use strict';

/**
 * Shared zod primitives.
 *
 * Defining these once means `phone` has exactly one definition in the system. The
 * previous implementation accepted any string as a phone number, so a user typing
 * "+919876543210" created a different account from one typing "9876543210", and
 * neither was ever validated.
 */

const { z } = require('zod');
const { config } = require('../config');

/**
 * Normalises a phone number to bare national digits.
 * Accepts "+91 98765 43210", "09876543210", "9876543210" → "9876543210".
 */
function normalisePhone(raw) {
  if (raw === null || raw === undefined) return '';
  let digits = String(raw).replace(/[^\d]/g, '');
  const cc = config.otp.msg91.countryCode || '91';
  if (digits.length > 10 && digits.startsWith(cc)) digits = digits.slice(cc.length);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

const phone = z
  .string({ required_error: 'Phone number is required' })
  .trim()
  .transform(normalisePhone)
  .refine((v) => /^[6-9]\d{9}$/.test(v), {
    message: 'Enter a valid 10-digit mobile number',
  });

const otpCode = z
  .string({ required_error: 'Enter the code we sent you' })
  .trim()
  .regex(new RegExp(`^\\d{${config.otp.length}}$`), `Enter the ${config.otp.length}-digit code`);

const id = z.coerce
  .number({ invalid_type_error: 'Invalid identifier' })
  .int('Invalid identifier')
  .positive('Invalid identifier');

const optionalId = id.optional();

const vehicleType = z.enum(['car', 'bike'], {
  errorMap: () => ({ message: 'Vehicle type must be car or bike' }),
});

/**
 * An instant supplied by a client.
 *
 * Requires an explicit UTC offset. Rejecting naive datetimes is the fix for the
 * defect where the customer app sent local wall-clock time and the owner app sent
 * UTC, leaving every conflict, price and refund decision resting on an unknown zone.
 */
const instant = z
  .string({ required_error: 'A date and time is required' })
  .trim()
  .refine((v) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(v), {
    message: 'Timestamp must include a timezone offset, e.g. 2026-04-13T10:00:00Z',
  })
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: 'Not a valid date and time' })
  .transform((v) => new Date(v));

const durationMinutes = z.coerce
  .number()
  .int('Duration must be a whole number of minutes')
  .min(config.booking.minDurationMinutes, `Minimum booking is ${config.booking.minDurationMinutes} minutes`)
  .max(config.booking.maxDurationMinutes, `Maximum booking is ${config.booking.maxDurationMinutes} minutes`);

/** Vehicle registration plate. Stored uppercase without spaces. */
const numberPlate = z
  .string({ required_error: 'Vehicle number is required' })
  .trim()
  .min(4, 'Vehicle number looks too short')
  .max(16, 'Vehicle number looks too long')
  .transform((v) => v.toUpperCase().replace(/\s+/g, ''))
  .refine((v) => /^[A-Z0-9-]+$/.test(v), {
    message: 'Vehicle number can only contain letters, numbers and dashes',
  });

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

/** Cursor pagination. Opaque to the client; base64 of a sort key server-side. */
const cursor = z.string().trim().max(512).optional();

const limit = z.coerce.number().int().min(1).max(100).default(20);

const paginationQuery = z.object({ cursor, limit });

/** Free-text search term, length-bounded and trimmed. */
const searchQuery = z.string().trim().min(1).max(120).optional();

/** A short human label such as a device name. */
const label = z.string().trim().min(1).max(60).optional();

module.exports = {
  z,
  normalisePhone,
  phone,
  otpCode,
  id,
  optionalId,
  vehicleType,
  instant,
  durationMinutes,
  numberPlate,
  latitude,
  longitude,
  cursor,
  limit,
  paginationQuery,
  searchQuery,
  label,
};
