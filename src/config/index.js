'use strict';

/**
 * Centralised, validated configuration.
 *
 * Every externally-configurable value in the system is read here and nowhere else.
 * The process refuses to start if a required secret is missing, which is the point:
 * the previous implementation hardcoded the database URI, the payment key and the
 * OTP provider key directly in server.js.
 *
 * See .env.example for the full list.
 */

const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];

/** @param {string} name @param {string|undefined} fallback */
function str(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Config: ${name} must be an integer, received "${v}"`);
  }
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

const env = str('NODE_ENV', 'development');
const isProduction = env === 'production';
const isTest = env === 'test';

const config = {
  env,
  isProduction,
  isTest,

  /**
   * Absolute base this API is reachable at, used to turn stored relative paths
   * into URLs a client can actually fetch.
   *
   * Uploaded photographs are stored root-relative (`/uploads/parking/1/x.jpg`)
   * so a row stays correct if the host changes, but a Flutter `Image.network`
   * has no base to resolve against — it needs the whole thing. On a device the
   * emulator's host alias differs from the server's own idea of localhost,
   * which is exactly why this is configuration rather than a guess.
   *
   *   PUBLIC_BASE_URL=http://10.0.2.2:3939
   */
  publicBaseUrl: str('PUBLIC_BASE_URL', ''),

  server: {
    port: int('PORT', 3000),
    host: str('HOST', '0.0.0.0'),
    // Comma-separated list. '*' is allowed only outside production.
    corsOrigins: str('CORS_ORIGINS', '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: bool('TRUST_PROXY', true),
    shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 10000),
  },

  db: {
    url: str('DATABASE_URL', undefined),
    poolMax: int('DB_POOL_MAX', 10),
    idleTimeoutMs: int('DB_IDLE_TIMEOUT_MS', 30000),
    connectionTimeoutMs: int('DB_CONNECTION_TIMEOUT_MS', 10000),
    statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 15000),
  },

  auth: {
    accessSecret: str('JWT_ACCESS_SECRET', undefined),
    refreshSecret: str('JWT_REFRESH_SECRET', undefined),
    accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 15 * 60), // 15 minutes
    refreshTtlSeconds: int('JWT_REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60), // 30 days
    issuer: str('JWT_ISSUER', 'parqx'),
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
  },

  otp: {
    length: 6,
    ttlSeconds: int('OTP_TTL_SECONDS', 5 * 60),
    maxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    // Per-phone cooldown between OTP requests.
    resendCooldownSeconds: int('OTP_RESEND_COOLDOWN_SECONDS', 30),
    // When true the OTP is returned in the API response and logged.
    // NEVER enable in production — the old implementation shipped this behaviour live.
    exposeInResponse: bool('OTP_EXPOSE_IN_RESPONSE', !isProduction),
    provider: str('OTP_PROVIDER', isProduction ? 'msg91' : 'console'),
    msg91: {
      authKey: str('MSG91_AUTH_KEY', undefined),
      templateName: str('MSG91_WA_TEMPLATE', 'transactional'),
      namespace: str('MSG91_WA_NAMESPACE', undefined),
      integratedNumber: str('MSG91_WA_NUMBER', undefined),
      countryCode: str('OTP_COUNTRY_CODE', '91'),
    },
  },

  payments: {
    provider: str('PAYMENTS_PROVIDER', 'razorpay'),
    razorpay: {
      keyId: str('RAZORPAY_KEY_ID', undefined),
      keySecret: str('RAZORPAY_KEY_SECRET', undefined),
      webhookSecret: str('RAZORPAY_WEBHOOK_SECRET', undefined),
    },
    currency: 'INR',
  },

  booking: {
    holdSeconds: int('HOLD_SECONDS', 120),
    // A booking awaiting payment is released after this long.
    pendingPaymentSeconds: int('PENDING_PAYMENT_SECONDS', 10 * 60),
    // Conflict buffer applied around a booking window.
    bufferMinutes: int('BOOKING_BUFFER_MINUTES', 10),
    defaultDurationMinutes: int('BOOKING_DEFAULT_DURATION_MINUTES', 60),
    minDurationMinutes: int('BOOKING_MIN_DURATION_MINUTES', 30),
    maxDurationMinutes: int('BOOKING_MAX_DURATION_MINUTES', 24 * 60),
    // How far ahead a booking may be made.
    maxAdvanceDays: int('BOOKING_MAX_ADVANCE_DAYS', 30),
    // Grace after expected exit before a no-show sweep.
    noShowGraceMinutes: int('BOOKING_NO_SHOW_GRACE_MINUTES', 60),
    // How early a customer may check in relative to their entry time, and how late
    // before the booking is treated as a no-show by the operator.
    checkInEarlyMinutes: int('BOOKING_CHECK_IN_EARLY_MINUTES', 30),
    checkInLateMinutes: int('BOOKING_CHECK_IN_LATE_MINUTES', 60),
    // A hold may be extended once, by this much, while the user is still choosing.
    holdExtensionSeconds: int('HOLD_EXTENSION_SECONDS', 120),
    maxHoldExtensions: int('HOLD_MAX_EXTENSIONS', 1),
    // At most this many live bookings per customer, to stop one account holding a
    // whole lot. 0 disables the check.
    maxActivePerUser: int('BOOKING_MAX_ACTIVE_PER_USER', 5),
  },

  pricing: {
    // Fallback base prices, in paise, used when a parking area has none configured.
    fallbackBasePaise: { car: 2000, bike: 1000 },
    occupancyWeight: Number(str('PRICING_OCCUPANCY_WEIGHT', '0.2')),
    // At or below this free-slot fraction a lot reads as "filling up" rather than
    // "available". Consumed by parkingService.availabilityState, which is the one
    // definition both apps and the map markers share.
    limitedAvailabilityRatio: Number(str('PRICING_LIMITED_AVAILABILITY_RATIO', '0.25')),
    forecastWeight: Number(str('PRICING_FORECAST_WEIGHT', '0.35')),
    minMultiplier: 1,
    maxMultiplier: Number(str('PRICING_MAX_MULTIPLIER', '1.8')),
    maxStepUpPerRequest: 0.18,
    maxStepDownPerRequest: 0.15,
    forecastLookbackMinutes: 60,
    forecastHorizonMinutes: 60,
    // Charged after the first hour, per started half hour.
    overstayHalfHourPaise: int('PRICING_OVERSTAY_HALF_HOUR_PAISE', 1000),
    platformFeeBps: int('PLATFORM_FEE_BPS', 0), // basis points, 0 = no fee
    // Share of the total payable up front, by demand level. PARQX currently
    // collects the full amount at booking (see bookingService.createFromHold), so
    // this drives the informational `advance_payable_paise` line only; it exists as
    // real configuration rather than the hardcoded 0.25 the code fell back to.
    advanceRatioByDemand: {
      low: Number(str('PRICING_ADVANCE_RATIO_LOW', '0.2')),
      medium: Number(str('PRICING_ADVANCE_RATIO_MEDIUM', '0.3')),
      high: Number(str('PRICING_ADVANCE_RATIO_HIGH', '0.4')),
      fallback: 0.25,
    },
    demandSignalWeights: {
      activeHold: 0.55,
      recentPendingBooking: 0.45,
      recentVerifiedBooking: 0.25,
      recentDeparture: -0.35,
    },
  },

  refunds: {
    // Slabs are evaluated top-down against minutes remaining until entry.
    slabs: [
      { minMinutesBefore: 60, percent: 60 },
      { minMinutesBefore: 30, percent: 40 },
      { minMinutesBefore: 15, percent: 25 },
      { minMinutesBefore: 0, percent: 0 },
    ],
  },

  rateLimit: {
    enabled: bool('RATE_LIMIT_ENABLED', true),
    otpRequestPerHour: int('RATE_LIMIT_OTP_PER_HOUR', 5),
    otpVerifyPerHour: int('RATE_LIMIT_OTP_VERIFY_PER_HOUR', 10),
    authPerHour: int('RATE_LIMIT_AUTH_PER_HOUR', 20),
    writePerMinute: int('RATE_LIMIT_WRITE_PER_MINUTE', 60),
    readPerMinute: int('RATE_LIMIT_READ_PER_MINUTE', 240),
  },

  jobs: {
    enabled: bool('JOBS_ENABLED', true),
    holdSweepIntervalMs: int('JOB_HOLD_SWEEP_MS', 5000),
    bookingSweepIntervalMs: int('JOB_BOOKING_SWEEP_MS', 30000),
    refundDispatchIntervalMs: int('JOB_REFUND_DISPATCH_MS', 120000),
  },

  logging: {
    level: str('LOG_LEVEL', isTest ? 'silent' : isProduction ? 'info' : 'debug'),
    // Redacted before anything reaches a log sink.
    redactPaths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.otp',
      'req.body.password',
      'req.body.refresh_token',
      '*.password',
      '*.otp',
      '*.access_token',
      '*.refresh_token',
    ],
  },

  /**
   * Feature flags. Every behaviour-changing migration step is gated on one of these
   * so that rollback is a config flip rather than a redeploy.
   */
  features: {
    // When false, /api/v1 routes that would normally require a token allow anonymous
    // access. Exists only to stage the auth rollout; must be true in production.
    authRequired: bool('FEATURE_AUTH_REQUIRED', true),
    // When false, payment verification falls back to the legacy trust-the-client
    // behaviour and logs loudly. Must be true in production.
    serverPaymentVerification: bool('FEATURE_SERVER_PAYMENT_VERIFICATION', true),
    // Actually call the payment provider's refund API on cancellation.
    refundsEnabled: bool('FEATURE_REFUNDS_ENABLED', false),
    // Mount the deprecated /api/* routes used by already-shipped app builds.
    legacyRoutesEnabled: bool('FEATURE_LEGACY_ROUTES_ENABLED', true),
    // Destructive dev helper.
    devReset: bool('ENABLE_DEV_RESET', false),
  },
};

/**
 * Validates configuration and returns a list of human-readable problems.
 * Called at boot; in production any problem is fatal.
 * @returns {string[]}
 */
function validate() {
  const problems = [];

  for (const key of REQUIRED_IN_PRODUCTION) {
    if (isProduction && !process.env[key]) {
      problems.push(`${key} is required in production`);
    }
  }

  if (!config.db.url) {
    problems.push(
      'DATABASE_URL is not set. Copy .env.example to .env and set it — ' +
        'the connection string is no longer hardcoded.'
    );
  }

  if (isProduction) {
    if (config.server.corsOrigins.includes('*')) {
      problems.push('CORS_ORIGINS must not be "*" in production');
    }
    if (config.otp.exposeInResponse) {
      problems.push('OTP_EXPOSE_IN_RESPONSE must be false in production');
    }
    if (config.features.devReset) {
      problems.push('ENABLE_DEV_RESET must be false in production');
    }
    if (!config.features.authRequired) {
      problems.push('FEATURE_AUTH_REQUIRED must be true in production');
    }
    if (!config.features.serverPaymentVerification) {
      problems.push('FEATURE_SERVER_PAYMENT_VERIFICATION must be true in production');
    }
    if (config.auth.accessSecret && config.auth.accessSecret === config.auth.refreshSecret) {
      problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
    }
    if (config.auth.accessSecret && config.auth.accessSecret.length < 32) {
      problems.push('JWT_ACCESS_SECRET must be at least 32 characters');
    }
    if (config.payments.provider === 'razorpay' && !config.payments.razorpay.keySecret) {
      problems.push('RAZORPAY_KEY_SECRET is required when PAYMENTS_PROVIDER=razorpay');
    }
    if (config.otp.provider === 'msg91' && !config.otp.msg91.authKey) {
      problems.push('MSG91_AUTH_KEY is required when OTP_PROVIDER=msg91');
    }
  }

  if (config.booking.minDurationMinutes > config.booking.maxDurationMinutes) {
    problems.push('BOOKING_MIN_DURATION_MINUTES exceeds BOOKING_MAX_DURATION_MINUTES');
  }

  return problems;
}

/** Fills in development-only defaults so `npm run dev` works without a .env for secrets. */
function applyDevDefaults() {
  if (isProduction) return;
  if (!config.auth.accessSecret) {
    config.auth.accessSecret = 'dev-only-access-secret-change-me-0123456789';
  }
  if (!config.auth.refreshSecret) {
    config.auth.refreshSecret = 'dev-only-refresh-secret-change-me-9876543210';
  }
}

applyDevDefaults();

module.exports = { config, validate };
