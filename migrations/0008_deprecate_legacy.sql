-- ============================================================================
-- 0008  Deprecate legacy structures
--
-- DO NOT RUN until client telemetry shows the /api/* legacy routes receiving zero
-- traffic. Check with:
--   SELECT * FROM deprecated_endpoint_usage ORDER BY last_seen_at DESC;
--
-- Nothing is dropped. Tables are renamed and replaced with views, so a rollback is
-- a rename back. The old system's habit of DELETE-as-lifecycle is exactly what this
-- migration exists to avoid repeating.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Telemetry table that gates this migration.
-- Written by the legacy-route middleware on every deprecated call.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deprecated_endpoint_usage (
  endpoint      text        NOT NULL,
  method        text        NOT NULL,
  client_label  text        NOT NULL DEFAULT 'unknown',
  hits          bigint      NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at  timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (endpoint, method, client_label)
);


-- ----------------------------------------------------------------------------
-- Guard: refuse to deprecate while legacy clients are still calling.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_recent bigint;
BEGIN
  SELECT COUNT(*) INTO v_recent
  FROM deprecated_endpoint_usage
  WHERE last_seen_at > NOW() - interval '7 days';

  IF v_recent > 0 THEN
    RAISE EXCEPTION
      'Refusing to deprecate: % legacy endpoints were called in the last 7 days. '
      'Wait for shipped app builds to migrate to /api/v1, or clear the table deliberately.',
      v_recent;
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 1. `slots` → `slots_legacy_unused`
--
-- Write-only in the old design: upserted during booking, deleted on capacity
-- change, and never read by any query. Superseded by parking_slots.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'slots')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'slots_legacy_unused') THEN
    ALTER TABLE slots RENAME TO slots_legacy_unused;
    COMMENT ON TABLE slots_legacy_unused IS
      'DEPRECATED 0008. Write-only legacy table, never read. Superseded by parking_slots. '
      'Retained for forensics; safe to drop once no longer needed.';
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 2. `register_login` → `owners_legacy`, with a compatibility view
--
-- A view keeps any straggling read working while the underlying data lives in
-- `owners`. Writes through the view are not supported — they were only ever done
-- by the legacy routes, which are gone by the time this migration runs.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'register_login')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'owners_legacy') THEN
    ALTER TABLE register_login RENAME TO owners_legacy;

    EXECUTE $view$
      CREATE OR REPLACE VIEW register_login AS
      SELECT
        o.id,
        o.phone,
        o.name AS parking_area_name,
        NULL::text AS password,      -- never expose a credential through a view
        o.created_at,
        o.updated_at
      FROM owners o
    $view$;

    COMMENT ON VIEW register_login IS
      'DEPRECATED 0008. Read-only compatibility view over owners. '
      'password is always NULL by design.';
    COMMENT ON TABLE owners_legacy IS
      'DEPRECATED 0008. Original register_login table, including plaintext passwords '
      'that were hashed into owners.password_hash during 0005. '
      'SCRUB BEFORE ANY EXPORT — see the notice below.';
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 3. Scrub the retained plaintext passwords
--
-- 0005 hashed them into owners.password_hash. Keeping the plaintext copy around
-- serves no purpose and is the single worst row in the database.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'owners_legacy') THEN
    -- Only scrub where the hash made it across, so nothing becomes unrecoverable.
    EXECUTE $sql$
      UPDATE owners_legacy ol
      SET password = '[scrubbed-0008]'
      FROM owners o
      WHERE o.phone = ol.phone
        AND o.password_hash IS NOT NULL
        AND ol.password IS NOT NULL
        AND ol.password <> '[scrubbed-0008]'
    $sql$;
    RAISE NOTICE 'Plaintext passwords scrubbed from owners_legacy where a hash exists in owners.';
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 4. booking_history → read-only
--
-- Its rows were copied into `bookings` with terminal statuses in 0005. Blocking
-- writes prevents a stray legacy code path from creating a second source of truth.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_booking_history_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'booking_history is read-only since migration 0008. '
    'Booking lifecycle now lives in bookings.status plus booking_events.';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_booking_history_readonly'
  ) THEN
    CREATE TRIGGER trg_booking_history_readonly
      BEFORE INSERT OR UPDATE OR DELETE ON booking_history
      FOR EACH STATEMENT EXECUTE FUNCTION reject_booking_history_write();
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 5. Drop the legacy columns superseded by typed replacements
--
-- Renamed rather than dropped, so the values survive.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  -- bookings.amount (numeric rupees) → superseded by amount_paise (integer)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'amount'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'amount_legacy_rupees'
  ) THEN
    ALTER TABLE bookings RENAME COLUMN amount TO amount_legacy_rupees;
  END IF;

  -- bookings.is_verified → superseded by status
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'is_verified'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'is_verified_legacy'
  ) THEN
    ALTER TABLE bookings RENAME COLUMN is_verified TO is_verified_legacy;
  END IF;
END $$;


DO $$
BEGIN
  RAISE NOTICE '0008 complete. Legacy structures renamed, not dropped.';
  RAISE NOTICE 'Rollback: rename slots_legacy_unused -> slots, drop view register_login, '
               'rename owners_legacy -> register_login, drop the read-only trigger.';
END $$;
