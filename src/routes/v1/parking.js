'use strict';

/**
 * /api/v1/parking — discovery.
 *
 * Every route is readable (optionalAuth): browsing parking does not require an
 * account, which is what makes the app useful before sign-in. Identity is attached
 * when present so availability can mark a slot as `held_by_you`.
 */

const express = require('express');
const { validate } = require('../../middleware/validate');
const { limiters } = require('../../middleware/rateLimit');
const { optionalAuth } = require('../../middleware/auth');
const schemas = require('../../validators/parking');
const controller = require('../../controllers/parkingController');

const router = express.Router();

router.use(optionalAuth);
router.use(limiters.read);

// Static paths first: /bounds and /suggest must not be captured by /:id.
router.get('/bounds', validate(schemas.bounds), controller.byBounds);
router.get('/suggest', validate(schemas.suggest), controller.suggest);

router.get('/', validate(schemas.search), controller.search);

router.get('/:id', validate(schemas.detail), controller.detail);
router.get('/:id/pricing', validate(schemas.pricing), controller.pricing);
router.get('/:id/availability', validate(schemas.availability), controller.availability);

module.exports = router;
