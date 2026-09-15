'use strict';

/**
 * Typed application errors.
 *
 * The previous implementation returned `String(err)` to clients, leaking Postgres
 * table and column names. Here, only `AppError` instances produce a client-visible
 * message; everything else becomes a generic 500 and is logged server-side.
 */

class AppError extends Error {
  /**
   * @param {object} opts
   * @param {number} opts.status        HTTP status
   * @param {string} opts.code          stable machine-readable code, SCREAMING_SNAKE
   * @param {string} opts.message       safe to show a client
   * @param {object} [opts.details]     safe structured detail (field errors etc.)
   * @param {Error}  [opts.cause]       original error, logged but never returned
   */
  constructor({ status, code, message, details, cause }) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, AppError);
  }
}

const badRequest = (message, details, code = 'BAD_REQUEST') =>
  new AppError({ status: 400, code, message, details });

const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') =>
  new AppError({ status: 401, code, message });

const forbidden = (message = 'You do not have access to this resource', code = 'FORBIDDEN') =>
  new AppError({ status: 403, code, message });

const notFound = (message = 'Resource not found', code = 'NOT_FOUND') =>
  new AppError({ status: 404, code, message });

const conflict = (message, code = 'CONFLICT', details) =>
  new AppError({ status: 409, code, message, details });

const unprocessable = (message, details, code = 'VALIDATION_FAILED') =>
  new AppError({ status: 422, code, message, details });

const tooManyRequests = (message = 'Too many requests', details, code = 'RATE_LIMITED') =>
  new AppError({ status: 429, code, message, details });

const internal = (message = 'Something went wrong', cause) =>
  new AppError({ status: 500, code: 'INTERNAL_ERROR', message, cause });

const serviceUnavailable = (message = 'Service temporarily unavailable', cause) =>
  new AppError({ status: 503, code: 'SERVICE_UNAVAILABLE', message, cause });

/**
 * Domain-specific errors used across services. Having these named means the API
 * contract, the tests and the Flutter clients all agree on one vocabulary.
 */
const DomainErrors = {
  slotUnavailable: (details) =>
    conflict('That slot is no longer available', 'SLOT_UNAVAILABLE', details),

  slotHeldByAnother: () =>
    conflict('Someone else is holding this slot right now', 'SLOT_HELD_BY_ANOTHER'),

  holdExpired: () =>
    conflict('Your hold on this slot expired. Please pick a slot again.', 'HOLD_EXPIRED'),

  timeOverlap: (details) =>
    conflict('This slot is already booked around that time', 'TIME_OVERLAP', details),

  bookingNotCancellable: (status) =>
    conflict(`A booking in state ${status} cannot be cancelled`, 'BOOKING_NOT_CANCELLABLE', {
      status,
    }),

  invalidTransition: (from, to) =>
    conflict(`Cannot move a booking from ${from} to ${to}`, 'INVALID_BOOKING_TRANSITION', {
      from,
      to,
    }),

  paymentVerificationFailed: () =>
    badRequest(
      'Payment could not be verified. If you were charged, it will be refunded automatically.',
      undefined,
      'PAYMENT_VERIFICATION_FAILED'
    ),

  paymentAlreadySettled: () =>
    conflict('This payment has already been processed', 'PAYMENT_ALREADY_SETTLED'),

  otpInvalid: () => badRequest('That code is not correct', undefined, 'OTP_INVALID'),

  otpExpired: () =>
    badRequest('That code has expired. Request a new one.', undefined, 'OTP_EXPIRED'),

  otpTooManyAttempts: () =>
    tooManyRequests('Too many incorrect attempts. Request a new code.', undefined, 'OTP_LOCKED'),

  capacityReductionBlocked: (details) =>
    conflict(
      'Capacity cannot be reduced while those slots have upcoming bookings',
      'CAPACITY_REDUCTION_BLOCKED',
      details
    ),

  impactChanged: () =>
    conflict(
      'The impact of this change differs from what you reviewed. Please review it again.',
      'IMPACT_HASH_MISMATCH'
    ),
};

/** Postgres error codes worth translating into domain errors. */
const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
};

/** True when a failed transaction is worth retrying. */
function isRetryablePgError(err) {
  return (
    err &&
    (err.code === PG.SERIALIZATION_FAILURE ||
      err.code === PG.DEADLOCK_DETECTED ||
      err.code === PG.LOCK_NOT_AVAILABLE)
  );
}

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests,
  internal,
  serviceUnavailable,
  DomainErrors,
  PG,
  isRetryablePgError,
};
