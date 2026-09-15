'use strict';

/**
 * Authentication and authorisation.
 *
 * This middleware is the single thing the previous system lacked entirely: every
 * endpoint on the old backend was anonymous, so knowing a phone number was
 * equivalent to being that person.
 *
 * Three guards:
 *   requireAuth        a valid access token is mandatory
 *   optionalAuth       attaches identity when present, never rejects
 *   requireRole(...)   role gate, applied after requireAuth
 *
 * Resource-level ownership ("is this YOUR parking area?") is enforced in services,
 * not here, because it needs a database lookup.
 */

const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { unauthorized, forbidden } = require('../utils/errors');

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * @typedef {object} AuthContext
 * @property {number}  id       users.id or owners.id
 * @property {'customer'|'owner'} role
 * @property {string}  phone
 * @property {string}  jti      token id, for revocation checks
 */

function extractToken(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const match = BEARER.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Verifies an access token and returns its claims, or throws an AppError. */
function verifyAccessToken(token) {
  try {
    const claims = jwt.verify(token, config.auth.accessSecret, {
      issuer: config.auth.issuer,
      algorithms: ['HS256'],
    });

    if (claims.typ !== 'access') {
      // A refresh token must never be usable as an access token.
      throw unauthorized('Invalid token type', 'TOKEN_WRONG_TYPE');
    }
    return claims;
  } catch (err) {
    if (err.status) throw err; // already an AppError
    if (err.name === 'TokenExpiredError') {
      throw unauthorized('Your session expired', 'TOKEN_EXPIRED');
    }
    throw unauthorized('Invalid authentication token', 'TOKEN_INVALID');
  }
}

function toAuthContext(claims) {
  return {
    id: Number(claims.sub),
    role: claims.role,
    phone: claims.phone,
    jti: claims.jti,
  };
}

/** Rejects the request unless a valid access token is present. */
function requireAuth(req, res, next) {
  // Staged rollout: with FEATURE_AUTH_REQUIRED=false the guard degrades to optional
  // so that already-shipped app builds keep working while clients migrate.
  // Config validation makes this impossible in production.
  if (!config.features.authRequired) return optionalAuth(req, res, next);

  const token = extractToken(req);
  if (!token) {
    return next(unauthorized('Sign in to continue', 'TOKEN_MISSING'));
  }

  try {
    req.auth = toAuthContext(verifyAccessToken(token));
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Attaches identity when a valid token is present; never rejects. */
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();
  try {
    req.auth = toAuthContext(verifyAccessToken(token));
  } catch {
    // Deliberately ignored: the caller opted into anonymous access.
  }
  return next();
}

/**
 * Restricts a route to one or more roles. Must run after requireAuth.
 * @param {...('customer'|'owner')} roles
 */
function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    if (!req.auth) {
      return next(unauthorized('Sign in to continue', 'TOKEN_MISSING'));
    }
    if (!roles.includes(req.auth.role)) {
      return next(
        forbidden(
          `This action is only available to ${roles.join(' or ')} accounts`,
          'ROLE_NOT_PERMITTED'
        )
      );
    }
    return next();
  };
}

/**
 * Guards a `:userId`-style path parameter so a customer can only address their own
 * records. Prevents the old system's defining flaw, where
 * GET /api/users/bookings/<any phone> returned that person's movement history.
 */
function requireSelf(paramName = 'userId') {
  return function selfGuard(req, res, next) {
    if (!req.auth) return next(unauthorized('Sign in to continue', 'TOKEN_MISSING'));
    const requested = String(req.params[paramName] ?? '');
    if (requested !== String(req.auth.id) && requested !== req.auth.phone) {
      return next(forbidden('You can only access your own records', 'NOT_SELF'));
    }
    return next();
  };
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireRole,
  requireSelf,
  verifyAccessToken,
  extractToken,
};
