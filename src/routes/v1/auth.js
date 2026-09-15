'use strict';

/**
 * /api/v1/auth
 *
 * Routers declare: path, rate limit, validation schema, auth guard, controller.
 * They contain no logic, so the security posture of an endpoint is readable in one
 * line — which was impossible in the previous 1,672-line single-file backend.
 */

const express = require('express');
const { validate } = require('../../middleware/validate');
const { limiters } = require('../../middleware/rateLimit');
const { requireAuth, requireRole, optionalAuth } = require('../../middleware/auth');
const schemas = require('../../validators/auth');
const controller = require('../../controllers/authController');

const router = express.Router();

/* ── customer ──────────────────────────────────────────────────────────────── */

router.post(
  '/otp/request',
  limiters.otpRequest,
  validate(schemas.requestOtp),
  controller.requestOtp
);

router.post(
  '/otp/verify',
  limiters.otpVerify,
  validate(schemas.verifyOtp),
  controller.verifyOtp
);

/* ── owner ─────────────────────────────────────────────────────────────────── */

router.post(
  '/owner/otp/request',
  limiters.otpRequest,
  validate({
    body: schemas.requestOtp.body.extend({}),
  }),
  (req, res, next) => {
    req.body.role = 'owner';
    next();
  },
  controller.requestOtp
);

router.post(
  '/owner/otp/verify',
  limiters.otpVerify,
  validate(schemas.verifyOtp),
  controller.verifyOtp
);

router.post(
  '/owner/password',
  limiters.auth,
  validate(schemas.ownerPasswordLogin),
  controller.ownerPasswordLogin
);

router.post(
  '/owner/password/set',
  requireAuth,
  requireRole('owner'),
  validate(schemas.setOwnerPassword),
  controller.setOwnerPassword
);

/* ── session lifecycle ─────────────────────────────────────────────────────── */

router.post('/refresh', limiters.auth, validate(schemas.refresh), controller.refresh);

// optionalAuth: logging out with an expired access token must still work.
router.post('/logout', optionalAuth, validate(schemas.logout), controller.logout);

router.get('/sessions', requireAuth, controller.listSessions);

module.exports = router;
