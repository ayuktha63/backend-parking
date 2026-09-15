-- ----------------------------------------------------------------------------
-- 0011 — parking photographs become writable
--
-- The read path for photographs already existed: `parking_photos` has been in
-- the schema since the booking engine migration, `parkingRepository` selects a
-- `cover_photo_url` for the discovery list and a `photos[]` array for the detail
-- page, and both clients have parsed them since the rewrite.
--
-- What did not exist was any way to PUT a photograph there. The configuration
-- service reported `upload_supported: false` and that was the whole story.
--
-- This migration makes the write path auditable. It changes no table structure:
-- `parking_photos` is already correctly shaped.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- Audit event types
-- ----------------------------------------------------------------------------
-- Adding, removing or re-covering a photograph is a configuration change an
-- operator made to a lot, and it belongs in the same audit trail as a price or
-- an hours change — it alters what a customer sees before they commit money.
--
-- Without this the CHECK rejects the audit insert, the surrounding transaction
-- rolls back, and the upload fails AFTER the bytes have been written to disk.
-- (Observed exactly that: one orphaned file, zero rows.)
ALTER TABLE parking_audit_events
  DROP CONSTRAINT IF EXISTS chk_parking_audit_type;

ALTER TABLE parking_audit_events
  ADD CONSTRAINT chk_parking_audit_type CHECK (event_type = ANY (ARRAY[
    'slot_closed',
    'slot_reopened',
    'capacity_increased',
    'capacity_reduced',
    'capacity_reduction_blocked',
    'pricing_changed',
    'hours_changed',
    'details_changed',
    'amenities_changed',
    'lot_activated',
    'lot_deactivated',
    -- new in 0011
    'photo_added',
    'photo_removed',
    'photo_cover_changed'
  ]));

-- ----------------------------------------------------------------------------
-- At most one cover per lot
-- ----------------------------------------------------------------------------
-- The service maintains this (setCover flips every row in one statement, and
-- deleting a cover promotes the next photo), but "the application is careful"
-- is not a constraint. Two covers would make `cover_photo_url` — which uses
-- ORDER BY is_cover DESC LIMIT 1 — return an arbitrary one of them, so the
-- discovery card would change picture between requests for no visible reason.
CREATE UNIQUE INDEX IF NOT EXISTS uq_parking_photos_one_cover
  ON parking_photos (parking_area_id)
  WHERE is_cover;

-- Ordering index: the detail page reads cover-first, then sort_order.
CREATE INDEX IF NOT EXISTS idx_parking_photos_area_order
  ON parking_photos (parking_area_id, is_cover DESC, sort_order ASC);

DO $$
BEGIN
  RAISE NOTICE '0011 complete — parking photo uploads are auditable and single-covered.';
END $$;
