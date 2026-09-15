'use strict';

/**
 * Stored relative, served absolute.
 *
 * The database keeps a root-relative path so the same row stays correct if the
 * host changes. Clients are given a fully-qualified URL because a Flutter
 * `Image.network` has no base to resolve against.
 *
 * Lives in utils, depending only on config, so that anything serialising a URL
 * can use it without pulling in the photo service — whose dependency on the
 * operator service once closed a require cycle back into bookingService and
 * left the operator's check-in calling an empty module.
 */

const { config } = require('../config');

function absolute(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = (config.publicBaseUrl || '').replace(/\/+$/, '');
  return base ? `${base}${url}` : url;
}

module.exports = { absolute };
