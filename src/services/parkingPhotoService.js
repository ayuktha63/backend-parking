'use strict';

/**
 * Parking photographs — the operator's write path.
 *
 * The READ path already existed: `parkingRepository` selects a `cover_photo_url`
 * for the discovery list and a `photos[]` array for the detail page, and the
 * clients have parsed both since the rewrite. What was missing was any way for
 * an operator to actually put a photograph there — `parkingConfigService`
 * reported "Photo upload is not available yet" and that was the end of it.
 *
 * STORAGE
 *   Bytes are written to a directory on disk and served back as static files.
 *   This is deliberately the simplest thing that is genuinely persistent: the
 *   file survives a restart, the URL keeps working, and nothing is faked.
 *
 *   It is NOT what production should run. The shape of this module is the part
 *   that matters — `store()` takes bytes and returns a URL, and everything else
 *   works in terms of that URL — so swapping the body of `store()` for an S3 or
 *   GCS put is a contained change that touches no route, no controller and no
 *   client.
 *
 * WHY RAW BODIES RATHER THAN MULTIPART
 *   A multipart parser would be another dependency for one endpoint. Express
 *   ships `express.raw()`, and a single-file upload does not need field parsing:
 *   the client sends the bytes with an image Content-Type and the filename is
 *   generated here anyway. Less surface, nothing to keep patched.
 *
 * WHAT IS VALIDATED
 *   Content type against an allow-list, size against a cap, and the leading
 *   magic bytes against the declared type — because a Content-Type header is a
 *   claim by the caller, not a fact. A file that says JPEG and does not start
 *   like one is refused.
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const db = require('../db');
const { config } = require('../config');
const operatorService = require('./operatorService');
const operatorRepository = require('../repositories/operatorRepository');
const gateway = require('../sockets/gateway');
const { badRequest, notFound } = require('../utils/errors');

/** Where uploaded bytes live. Overridable so a deployment can mount a volume. */
const UPLOAD_ROOT =
  process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

/** Public path prefix these are served from. Must match app.js. */
const PUBLIC_PREFIX = '/uploads';

const MAX_BYTES = 6 * 1024 * 1024; // 6 MB
const MAX_PHOTOS_PER_AREA = 8;

/**
 * Accepted types, with the magic bytes each one must actually begin with.
 *
 * No SVG: it is a document format that can carry script, and it would be served
 * from our own origin.
 */
const ACCEPTED = {
  'image/jpeg': { ext: 'jpg', magic: [[0xff, 0xd8, 0xff]] },
  'image/png': { ext: 'png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  'image/webp': { ext: 'webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
};

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

function assertLooksLikeImage(buffer, contentType) {
  const spec = ACCEPTED[contentType];
  if (!spec) {
    throw badRequest(
      `Unsupported image type "${contentType}". Use JPEG, PNG or WebP.`,
      { accepted: Object.keys(ACCEPTED) },
      'UNSUPPORTED_MEDIA_TYPE'
    );
  }
  if (!spec.magic.some((m) => startsWith(buffer, m))) {
    // The header said one thing and the bytes say another.
    throw badRequest(
      'That file is not a valid image.',
      null,
      'INVALID_IMAGE'
    );
  }
  return spec;
}

/**
 * Writes bytes and returns the URL they will be served from.
 *
 * The single seam between "we have an image" and "where images live". Replace
 * the body of this function to move to object storage.
 */
async function store({ parkingAreaId, buffer, ext }) {
  const dir = path.join(UPLOAD_ROOT, 'parking', String(parkingAreaId));
  await fs.mkdir(dir, { recursive: true });

  const name = `${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(dir, name), buffer);

  return `${PUBLIC_PREFIX}/parking/${parkingAreaId}/${name}`;
}

async function remove(url) {
  if (!url || !url.startsWith(`${PUBLIC_PREFIX}/`)) return; // externally hosted
  const relative = url.slice(PUBLIC_PREFIX.length + 1);
  const target = path.join(UPLOAD_ROOT, relative);

  // Never delete outside the upload root, whatever the stored string says.
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(UPLOAD_ROOT))) return;

  await fs.rm(resolved, { force: true });
}

/* ── queries ───────────────────────────────────────────────────────────────── */

async function list({ ownerId, parkingAreaId = null }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });
  const { rows } = await db.query(
    `SELECT id, url, caption, is_cover, sort_order, created_at
       FROM parking_photos
      WHERE parking_area_id = $1
      ORDER BY is_cover DESC, sort_order ASC, id ASC`,
    [area.id]
  );
  return {
    parking_area_id: area.id,
    max_photos: MAX_PHOTOS_PER_AREA,
    max_bytes: MAX_BYTES,
    accepted_types: Object.keys(ACCEPTED),
    photos: rows.map(present),
  };
}

function present(row) {
  return {
    id: row.id,
    url: absolute(row.url),
    caption: row.caption ?? null,
    is_cover: row.is_cover === true,
    sort_order: row.sort_order ?? 0,
  };
}

/**
 * Stored relative, served absolute.
 *
 * The database keeps a root-relative path so the same row stays correct if the
 * host changes. Clients are given a fully-qualified URL because a Flutter
 * `Image.network` has no base to resolve against.
 */
function absolute(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = (config.publicBaseUrl || '').replace(/\/+$/, '');
  return base ? `${base}${url}` : url;
}

/* ── mutations ─────────────────────────────────────────────────────────────── */

async function add({ ownerId, parkingAreaId = null, buffer, contentType, caption = null }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });

  if (!buffer || buffer.length === 0) {
    throw badRequest('No image was received.', null, 'EMPTY_UPLOAD');
  }
  if (buffer.length > MAX_BYTES) {
    throw badRequest(
      `That image is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${
        MAX_BYTES / 1024 / 1024
      } MB.`,
      { max_bytes: MAX_BYTES },
      'IMAGE_TOO_LARGE'
    );
  }

  const spec = assertLooksLikeImage(buffer, contentType);

  const { rows: existing } = await db.query(
    'SELECT COUNT(*)::int AS count FROM parking_photos WHERE parking_area_id = $1',
    [area.id]
  );
  if (existing[0].count >= MAX_PHOTOS_PER_AREA) {
    throw badRequest(
      `This parking area already has ${MAX_PHOTOS_PER_AREA} photos. Remove one first.`,
      { max_photos: MAX_PHOTOS_PER_AREA },
      'PHOTO_LIMIT_REACHED'
    );
  }

  const url = await store({ parkingAreaId: area.id, buffer, ext: spec.ext });

  // The first photo becomes the cover automatically: a lot with photos but no
  // cover would show nothing on the discovery card, which is the one place a
  // photo matters most.
  const isFirst = existing[0].count === 0;

  // The bytes are on disk before the row exists, so a failed transaction would
  // strand them. Observed for real: the audit CHECK constraint rejected
  // 'photo_added' (fixed in migration 0011), the transaction rolled back, and
  // the upload left one orphaned file and zero rows.
  //
  // An orphaned file is harmless but it is still litter, and the failure that
  // produces it is exactly the kind that arrives in batches.
  let photo;
  try {
    photo = await db.withTransaction(async (tx) => {
      const { rows } = await db.query(
        `INSERT INTO parking_photos (parking_area_id, url, caption, is_cover, sort_order)
         VALUES ($1, $2, $3, $4,
                 COALESCE((SELECT MAX(sort_order) + 1 FROM parking_photos WHERE parking_area_id = $1), 0))
         RETURNING id, url, caption, is_cover, sort_order`,
        [area.id, url, caption, isFirst],
        tx
      );

      await operatorRepository.recordAudit(
        {
          parkingAreaId: area.id,
          ownerId,
          eventType: 'photo_added',
          detail: { photo_id: rows[0].id, bytes: buffer.length, content_type: contentType },
        },
        tx
      );

      return rows[0];
    });
  } catch (error) {
    // Best effort: if this also fails there is nothing useful left to do, and
    // the upload error is the one worth reporting.
    await remove(url).catch(() => {});
    throw error;
  }

  gateway.emitParkingConfigChanged(area.id, { change: 'photos' });
  return present(photo);
}

async function setCover({ ownerId, parkingAreaId = null, photoId }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });

  const updated = await db.withTransaction(async (tx) => {
    const { rows: found } = await db.query(
      'SELECT id FROM parking_photos WHERE id = $1 AND parking_area_id = $2',
      [photoId, area.id],
      tx
    );
    if (found.length === 0) {
      throw notFound('That photo could not be found', 'PHOTO_NOT_FOUND');
    }

    // Exactly one cover, always.
    await db.query(
      'UPDATE parking_photos SET is_cover = (id = $1) WHERE parking_area_id = $2',
      [photoId, area.id],
      tx
    );

    await operatorRepository.recordAudit(
      {
        parkingAreaId: area.id,
        ownerId,
        eventType: 'photo_cover_changed',
        detail: { photo_id: photoId },
      },
      tx
    );
    return true;
  });

  if (updated) gateway.emitParkingConfigChanged(area.id, { change: 'photos' });
  return list({ ownerId, parkingAreaId: area.id });
}

async function destroy({ ownerId, parkingAreaId = null, photoId }) {
  const area = await operatorService.resolveParkingArea({ ownerId, parkingAreaId });

  const removedUrl = await db.withTransaction(async (tx) => {
    const { rows } = await db.query(
      'SELECT id, url, is_cover FROM parking_photos WHERE id = $1 AND parking_area_id = $2',
      [photoId, area.id],
      tx
    );
    if (rows.length === 0) {
      throw notFound('That photo could not be found', 'PHOTO_NOT_FOUND');
    }

    await db.query('DELETE FROM parking_photos WHERE id = $1', [photoId], tx);

    // Removing the cover promotes the next photo rather than leaving the lot
    // with photos and no cover.
    if (rows[0].is_cover) {
      await db.query(
        `UPDATE parking_photos SET is_cover = TRUE
          WHERE id = (SELECT id FROM parking_photos
                       WHERE parking_area_id = $1
                    ORDER BY sort_order ASC, id ASC LIMIT 1)`,
        [area.id],
        tx
      );
    }

    await operatorRepository.recordAudit(
      {
        parkingAreaId: area.id,
        ownerId,
        eventType: 'photo_removed',
        detail: { photo_id: photoId },
      },
      tx
    );

    return rows[0].url;
  });

  // Bytes go only after the row is committed: an orphaned file is harmless,
  // a row pointing at a deleted file is a broken image on a customer's screen.
  await remove(removedUrl);

  gateway.emitParkingConfigChanged(area.id, { change: 'photos' });
  return list({ ownerId, parkingAreaId: area.id });
}

module.exports = {
  list,
  add,
  setCover,
  destroy,
  absolute,
  MAX_BYTES,
  MAX_PHOTOS_PER_AREA,
  ACCEPTED_TYPES: Object.keys(ACCEPTED),
};
