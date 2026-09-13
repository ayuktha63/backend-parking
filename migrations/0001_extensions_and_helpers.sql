-- ============================================================================
-- 0001  Extensions, shared helpers, and the migration-safety table
--
-- Purely additive. Creates nothing that existing code reads or writes.
-- Safe to run against the live database.
-- ============================================================================

-- btree_gist enables the exclusion constraint added in 0006, which is what makes
-- double-booking impossible at the storage layer rather than merely unlikely.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'btree_gist could not be created (insufficient privilege). '
               'Migration 0006 will skip the exclusion constraint and rely on '
               'advisory locking alone. Ask your DBA to run: CREATE EXTENSION btree_gist;';
END $$;

-- pgcrypto is optional: Postgres 13+ provides gen_random_uuid() natively.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pgcrypto not available; relying on built-in gen_random_uuid().';
END $$;


-- ----------------------------------------------------------------------------
-- updated_at maintenance
--
-- The old schema set updated_at by hand in some statements and forgot in others,
-- so the column could not be trusted. A trigger removes the choice.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Attaches the trigger to a table, idempotently.
CREATE OR REPLACE FUNCTION attach_updated_at(target_table regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  trigger_name text := 'trg_' || replace(target_table::text, '.', '_') || '_updated_at';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = target_table AND tgname = trigger_name AND NOT tgisinternal
  ) THEN
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      trigger_name, target_table::text
    );
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- migration_conflicts
--
-- Backfills (0004) never guess. Anything ambiguous — a parking area whose name
-- matches two owners, a booking whose phone matches no user — is recorded here and
-- left NULL. Migration 0006 refuses to add the corresponding NOT NULL / foreign key
-- until this table is empty for that concern.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_conflicts (
  id            bigserial PRIMARY KEY,
  migration     text        NOT NULL,
  concern       text        NOT NULL,   -- e.g. 'parking_areas.owner_id'
  entity_table  text        NOT NULL,
  entity_id     text        NOT NULL,
  reason        text        NOT NULL,
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  resolved_at   timestamptz,
  resolved_by   text,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_migration_conflicts_open
  ON migration_conflicts (concern)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE migration_conflicts IS
  'Ambiguities found during data backfill. Rows here block constraint tightening in 0006. '
  'Resolve by correcting the source data, then setting resolved_at.';


-- ----------------------------------------------------------------------------
-- Reference: enum-like domains
--
-- Implemented as CHECK constraints on text rather than native ENUM types.
-- Adding a value to a native enum cannot be done inside a transaction in older
-- Postgres, and altering one is awkward; text + CHECK stays migratable.
-- ----------------------------------------------------------------------------

-- Booking lifecycle. Documented here so the values have one definition.
--   PENDING_PAYMENT  created, awaiting server-verified payment
--   CONFIRMED        paid and reserved
--   CHECKED_IN       vehicle has arrived (owner confirmed)
--   COMPLETED        vehicle has left, final amount settled
--   CANCELLED        cancelled by customer or owner
--   NO_SHOW          never arrived within the grace window
--   EXPIRED          payment never completed in time
--
-- Payment status:  CREATED · AUTHORIZED · PAID · FAILED · REFUNDED · PARTIALLY_REFUNDED
-- Slot status is *derived*, never stored: available · held · booked · closed
