-- ============================================================================
-- 0007  Constraints — the tightening step
--
-- Adds the foreign keys, CHECKs and the no-overlap exclusion constraint that turn
-- the schema from "a set of tables" into something that enforces its own rules.
--
-- SAFETY GATE: every constraint here is conditional. If 0005's backfill left an
-- open conflict for the relevant concern, or if existing data would violate the
-- constraint, the statement is SKIPPED with a NOTICE rather than failing the
-- migration. That means this file is safe to run and safe to re-run: fix the data,
-- run it again, and the remaining constraints go on.
--
-- Check what is still outstanding with:
--   SELECT concern, COUNT(*) FROM migration_conflicts WHERE resolved_at IS NULL GROUP BY 1;
-- ============================================================================

-- Adds a constraint only if it does not already exist.
CREATE OR REPLACE FUNCTION add_constraint_if_absent(
  target_table text, constraint_name text, definition text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = constraint_name AND conrelid = target_table::regclass
  ) THEN
    RETURN false;
  END IF;
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', target_table, constraint_name, definition);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'SKIPPED constraint % on %: %', constraint_name, target_table, SQLERRM;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION open_conflicts(p_concern text) RETURNS bigint
LANGUAGE sql STABLE
AS $$
  SELECT COUNT(*) FROM migration_conflicts
  WHERE concern = p_concern AND resolved_at IS NULL;
$$;


-- ============================================================================
-- 1. Foreign keys
-- ============================================================================

-- vehicles → users
SELECT add_constraint_if_absent('vehicles', 'fk_vehicles_user',
  'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');

-- refresh_tokens → users / owners
SELECT add_constraint_if_absent('refresh_tokens', 'fk_refresh_user',
  'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');
SELECT add_constraint_if_absent('refresh_tokens', 'fk_refresh_owner',
  'FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE');

-- parking_slots → parking_areas
SELECT add_constraint_if_absent('parking_slots', 'fk_slots_area',
  'FOREIGN KEY (parking_area_id) REFERENCES parking_areas(id) ON DELETE CASCADE');

-- parking enrichment tables
SELECT add_constraint_if_absent('parking_photos', 'fk_photos_area',
  'FOREIGN KEY (parking_area_id) REFERENCES parking_areas(id) ON DELETE CASCADE');
SELECT add_constraint_if_absent('parking_amenities', 'fk_amenities_area',
  'FOREIGN KEY (parking_area_id) REFERENCES parking_areas(id) ON DELETE CASCADE');
SELECT add_constraint_if_absent('parking_amenities', 'fk_amenities_code',
  'FOREIGN KEY (amenity_code) REFERENCES amenities(code) ON DELETE RESTRICT');
SELECT add_constraint_if_absent('parking_opening_hours', 'fk_hours_area',
  'FOREIGN KEY (parking_area_id) REFERENCES parking_areas(id) ON DELETE CASCADE');
SELECT add_constraint_if_absent('parking_reviews', 'fk_reviews_area',
  'FOREIGN KEY (parking_area_id) REFERENCES parking_areas(id) ON DELETE CASCADE');
SELECT add_constraint_if_absent('parking_reviews', 'fk_reviews_user',
  'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');

-- payments / refunds → bookings
SELECT add_constraint_if_absent('payments', 'fk_payments_booking',
  'FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT');
SELECT add_constraint_if_absent('refunds', 'fk_refunds_payment',
  'FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT');
SELECT add_constraint_if_absent('booking_events', 'fk_events_booking',
  'FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE');


-- parking_areas → owners: gated on the backfill having been unambiguous.
DO $$
BEGIN
  IF open_conflicts('parking_areas.owner_id') > 0 THEN
    RAISE NOTICE 'SKIPPED fk_areas_owner: % parking areas could not be linked to an owner. '
                 'Resolve migration_conflicts, then re-run 0007.',
                 open_conflicts('parking_areas.owner_id');
  ELSE
    PERFORM add_constraint_if_absent('parking_areas', 'fk_areas_owner',
      'FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE RESTRICT');
  END IF;
END $$;

-- bookings → users: gated likewise.
DO $$
BEGIN
  IF open_conflicts('bookings.user_id') > 0 THEN
    RAISE NOTICE 'SKIPPED fk_bookings_user: % bookings have no matching user.',
                 open_conflicts('bookings.user_id');
  ELSE
    PERFORM add_constraint_if_absent('bookings', 'fk_bookings_user',
      'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT');
  END IF;
END $$;

SELECT add_constraint_if_absent('bookings', 'fk_bookings_area',
  'FOREIGN KEY (parking_id) REFERENCES parking_areas(id) ON DELETE RESTRICT');
SELECT add_constraint_if_absent('bookings', 'fk_bookings_slot',
  'FOREIGN KEY (parking_slot_id) REFERENCES parking_slots(id) ON DELETE RESTRICT');
SELECT add_constraint_if_absent('bookings', 'fk_bookings_vehicle',
  'FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL');

SELECT add_constraint_if_absent('slot_holds', 'fk_holds_slot',
  'FOREIGN KEY (parking_slot_id) REFERENCES parking_slots(id) ON DELETE CASCADE');
SELECT add_constraint_if_absent('slot_holds', 'fk_holds_user',
  'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');


-- ============================================================================
-- 2. Value constraints
-- ============================================================================

SELECT add_constraint_if_absent('bookings', 'chk_bookings_status',
  $c$CHECK (status IS NULL OR status IN
    ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN','COMPLETED','CANCELLED','NO_SHOW','EXPIRED'))$c$);

SELECT add_constraint_if_absent('bookings', 'chk_bookings_vehicle_type',
  $c$CHECK (vehicle_type IN ('car','bike'))$c$);

SELECT add_constraint_if_absent('bookings', 'chk_bookings_amount_nonneg',
  'CHECK (amount_paise IS NULL OR amount_paise >= 0)');

SELECT add_constraint_if_absent('bookings', 'chk_bookings_duration',
  'CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 10080)');

SELECT add_constraint_if_absent('bookings', 'chk_bookings_exit_after_entry',
  'CHECK (expected_exit_time IS NULL OR entry_time IS NULL OR expected_exit_time > entry_time)');

SELECT add_constraint_if_absent('bookings', 'chk_bookings_source',
  $c$CHECK (source IN ('customer_app','owner_app','walk_in','legacy','legacy_history','admin'))$c$);

SELECT add_constraint_if_absent('parking_areas', 'chk_areas_slots_nonneg',
  'CHECK (COALESCE(total_car_slots,0) >= 0 AND COALESCE(total_bike_slots,0) >= 0)');

SELECT add_constraint_if_absent('parking_areas', 'chk_areas_lat_range',
  'CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90))');

SELECT add_constraint_if_absent('parking_areas', 'chk_areas_lng_range',
  'CHECK (lng IS NULL OR (lng BETWEEN -180 AND 180))');

SELECT add_constraint_if_absent('parking_areas', 'chk_areas_price_nonneg',
  'CHECK (COALESCE(base_car_price_paise,0) >= 0 AND COALESCE(base_bike_price_paise,0) >= 0)');

SELECT add_constraint_if_absent('parking_areas', 'chk_areas_rating',
  'CHECK (rating_avg IS NULL OR (rating_avg BETWEEN 1 AND 5))');

SELECT add_constraint_if_absent('parking_areas', 'chk_areas_tz_offset',
  'CHECK (timezone_offset_minutes BETWEEN -840 AND 840)');

SELECT add_constraint_if_absent('slot_holds', 'chk_holds_vehicle_type',
  $c$CHECK (vehicle_type IN ('car','bike'))$c$);


-- ============================================================================
-- 3. NOT NULL tightening
--
-- Only applied where 0005 populated every row. Verified before each attempt.
-- ============================================================================
DO $$
DECLARE
  v_null_count bigint;
BEGIN
  SELECT COUNT(*) INTO v_null_count FROM bookings WHERE status IS NULL;
  IF v_null_count = 0 THEN
    BEGIN
      ALTER TABLE bookings ALTER COLUMN status SET NOT NULL;
      ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'PENDING_PAYMENT';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'SKIPPED NOT NULL on bookings.status: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'SKIPPED NOT NULL on bookings.status: % rows still NULL', v_null_count;
  END IF;

  SELECT COUNT(*) INTO v_null_count FROM bookings WHERE amount_paise IS NULL;
  IF v_null_count = 0 THEN
    BEGIN
      ALTER TABLE bookings ALTER COLUMN amount_paise SET NOT NULL;
      ALTER TABLE bookings ALTER COLUMN amount_paise SET DEFAULT 0;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'SKIPPED NOT NULL on bookings.amount_paise: %', SQLERRM;
    END;
  END IF;

  SELECT COUNT(*) INTO v_null_count FROM bookings WHERE booking_code IS NULL;
  IF v_null_count = 0 THEN
    BEGIN
      ALTER TABLE bookings ALTER COLUMN booking_code SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'SKIPPED NOT NULL on bookings.booking_code: %', SQLERRM;
    END;
  END IF;
END $$;


-- ============================================================================
-- 4. No-overlap exclusion constraint
--
-- This is the structural fix for double-booking.
--
-- The old implementation ran its overlap check BEFORE `BEGIN`, then relied on
-- `SELECT ... FOR UPDATE`, which locks nothing when a slot has no existing rows —
-- so two concurrent requests for a free slot could both succeed, and the slot-map
-- query then hid the duplicate by keeping only one row per slot.
--
-- An exclusion constraint makes the overlap physically impossible: Postgres refuses
-- the second insert regardless of timing, application code or deployment topology.
-- Application-level advisory locking remains, to turn the raw constraint violation
-- into a friendly error rather than a 500.
-- ============================================================================
DO $$
DECLARE
  v_has_btree_gist boolean;
  v_violations     bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist')
    INTO v_has_btree_gist;

  IF NOT v_has_btree_gist THEN
    RAISE NOTICE 'SKIPPED excl_bookings_no_overlap: btree_gist extension is not installed. '
                 'Run "CREATE EXTENSION btree_gist;" as a superuser, then re-run 0007.';
    RETURN;
  END IF;

  -- Existing data must already satisfy the constraint, or ADD CONSTRAINT fails.
  SELECT COUNT(*) INTO v_violations
  FROM bookings a
  JOIN bookings b
    ON a.id < b.id
   AND a.parking_slot_id = b.parking_slot_id
   AND a.parking_slot_id IS NOT NULL
   AND tstzrange(a.entry_time, a.expected_exit_time, '[)')
       && tstzrange(b.entry_time, b.expected_exit_time, '[)')
  WHERE a.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
    AND b.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN');

  IF v_violations > 0 THEN
    -- Record them rather than failing: these are pre-existing double-bookings that
    -- a human needs to resolve with the affected customers.
    INSERT INTO migration_conflicts (migration, concern, entity_table, entity_id, reason, details)
    SELECT DISTINCT '0007', 'bookings.no_overlap', 'bookings', b.id::text,
           'Overlaps an existing active booking for the same slot',
           jsonb_build_object('conflicts_with', a.id, 'slot_id', a.parking_slot_id)
    FROM bookings a
    JOIN bookings b
      ON a.id < b.id
     AND a.parking_slot_id = b.parking_slot_id
     AND a.parking_slot_id IS NOT NULL
     AND tstzrange(a.entry_time, a.expected_exit_time, '[)')
         && tstzrange(b.entry_time, b.expected_exit_time, '[)')
    WHERE a.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
      AND b.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
      AND NOT EXISTS (
        SELECT 1 FROM migration_conflicts mc
        WHERE mc.concern = 'bookings.no_overlap' AND mc.entity_id = b.id::text
      );

    RAISE NOTICE 'SKIPPED excl_bookings_no_overlap: % pre-existing overlapping bookings '
                 'recorded in migration_conflicts. Resolve them, then re-run 0007.', v_violations;
    RETURN;
  END IF;

  BEGIN
    ALTER TABLE bookings ADD CONSTRAINT excl_bookings_no_overlap
      EXCLUDE USING gist (
        parking_slot_id WITH =,
        tstzrange(entry_time, expected_exit_time, '[)') WITH &&
      )
      WHERE (
        parking_slot_id IS NOT NULL
        AND entry_time IS NOT NULL
        AND expected_exit_time IS NOT NULL
        AND status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
      );
    RAISE NOTICE 'excl_bookings_no_overlap added — double-booking is now impossible at the storage layer.';
  EXCEPTION WHEN duplicate_object THEN
    NULL;  -- already present
  WHEN OTHERS THEN
    RAISE NOTICE 'SKIPPED excl_bookings_no_overlap: %', SQLERRM;
  END;
END $$;


-- ============================================================================
-- 5. One active hold per slot
-- ============================================================================
DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_holds_one_active
      ON slot_holds (parking_slot_id)
      WHERE consumed_at IS NULL AND released_at IS NULL;
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'SKIPPED uq_slot_holds_one_active: duplicate active holds exist. '
                 'Run the hold sweeper, then re-run 0007.';
  END;
END $$;


-- ============================================================================
-- 6. Report
-- ============================================================================
DO $$
DECLARE
  v_open bigint;
BEGIN
  SELECT COUNT(*) INTO v_open FROM migration_conflicts WHERE resolved_at IS NULL;
  RAISE NOTICE '0007 complete. Open migration conflicts: %', v_open;
  IF v_open > 0 THEN
    RAISE NOTICE 'Some constraints were skipped. Resolve conflicts and re-run 0007 '
                 '(it is idempotent and will add only what is still missing).';
  END IF;
END $$;
