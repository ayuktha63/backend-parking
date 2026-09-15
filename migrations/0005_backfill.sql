-- ============================================================================
-- 0005  Data backfill
--
-- Populates the columns added in 0004 from existing data.
--
-- Three rules, because this migration runs against live customer records:
--   1. IDEMPOTENT. Every statement is re-runnable; all are guarded by "IS NULL"
--      or ON CONFLICT. A partial failure can simply be re-run.
--   2. NEVER GUESSES. Anything ambiguous is written to migration_conflicts and
--      left NULL. Migration 0007 refuses to add the matching constraint until the
--      conflict table is clear.
--   3. NEVER DESTROYS. No DELETE, no DROP, no UPDATE that discards a value.
--
-- Historical timestamps are deliberately NOT rewritten. The old system had the
-- customer app sending naive local time and the owner app sending UTC, so the true
-- instant behind an old entry_time is unknowable. Rewriting them would encode a
-- guess as fact; only new writes are UTC-normalised.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Helper: user-facing booking code, e.g. PQX-7F3K2A
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_booking_code(seed bigint)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  -- Crockford-style alphabet: no I, L, O or U, so codes survive being read aloud.
  alphabet  text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  n         bigint;
  out       text := '';
  i         integer;
BEGIN
  -- Mix the id so sequential bookings do not produce adjacent codes.
  n := (seed * 2654435761::bigint) % 1073741824::bigint;
  FOR i IN 1..6 LOOP
    out := substr(alphabet, (n % 32)::integer + 1, 1) || out;
    n := n / 32;
  END LOOP;
  RETURN 'PQX-' || out;
END;
$$;


-- ============================================================================
-- 1. owners ← register_login
-- ============================================================================
DO $$
DECLARE
  has_pgcrypto boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') INTO has_pgcrypto;

  IF has_pgcrypto THEN
    -- pgcrypto's crypt(..., gen_salt('bf', 12)) emits a $2a$ bcrypt hash, which
    -- bcryptjs verifies natively. Plaintext passwords are hashed in place and the
    -- owner is flagged for a reset, because the plaintext values are in git history
    -- and must be treated as disclosed.
    INSERT INTO owners (phone, name, password_hash, must_reset_password,
                        legacy_register_login_id, created_at, updated_at)
    SELECT
      rl.phone,
      NULLIF(rl.parking_area_name, ''),
      CASE WHEN rl.password IS NOT NULL AND rl.password <> ''
           THEN crypt(rl.password, gen_salt('bf', 12))
           ELSE NULL END,
      true,
      rl.id,
      COALESCE(rl.created_at, NOW()),
      NOW()
    FROM register_login rl
    WHERE rl.phone IS NOT NULL AND rl.phone <> ''
    ON CONFLICT (phone) DO NOTHING;
  ELSE
    -- Without pgcrypto we cannot hash here. Import without a password; those owners
    -- sign in by OTP and set a password afterwards. No plaintext is ever copied.
    INSERT INTO owners (phone, name, password_hash, must_reset_password,
                        legacy_register_login_id, created_at, updated_at)
    SELECT rl.phone, NULLIF(rl.parking_area_name, ''), NULL, true, rl.id,
           COALESCE(rl.created_at, NOW()), NOW()
    FROM register_login rl
    WHERE rl.phone IS NOT NULL AND rl.phone <> ''
    ON CONFLICT (phone) DO NOTHING;

    INSERT INTO migration_conflicts (migration, concern, entity_table, entity_id, reason, details)
    SELECT '0005', 'owners.password_hash', 'register_login', rl.id::text,
           'pgcrypto unavailable: password could not be hashed during migration',
           jsonb_build_object('phone_suffix', right(rl.phone, 3))
    FROM register_login rl
    WHERE rl.password IS NOT NULL AND rl.password <> ''
      AND NOT EXISTS (
        SELECT 1 FROM migration_conflicts mc
        WHERE mc.concern = 'owners.password_hash' AND mc.entity_id = rl.id::text
      );
  END IF;
END $$;


-- ============================================================================
-- 2. parking_areas.owner_id ← name match against owners.name
--
-- The legacy link was `register_login.parking_area_name = parking_areas.name`.
-- Where that match is unique, adopt it. Where it is ambiguous or absent, record a
-- conflict and leave owner_id NULL rather than attaching a lot to the wrong operator.
-- ============================================================================

-- 2a. Unambiguous matches.
UPDATE parking_areas pa
SET owner_id = m.owner_id
FROM (
  SELECT o.name AS area_name, MIN(o.id) AS owner_id
  FROM owners o
  WHERE o.name IS NOT NULL AND o.name <> ''
  GROUP BY o.name
  HAVING COUNT(*) = 1
) m
WHERE pa.owner_id IS NULL
  AND pa.name = m.area_name;

-- 2b. Ambiguous: two or more owners claim the same lot name.
INSERT INTO migration_conflicts (migration, concern, entity_table, entity_id, reason, details)
SELECT '0005', 'parking_areas.owner_id', 'parking_areas', pa.id::text,
       'Multiple owners share this parking area name; cannot determine the true owner',
       jsonb_build_object('parking_area_name', pa.name, 'candidate_owner_ids',
                          (SELECT jsonb_agg(o2.id) FROM owners o2 WHERE o2.name = pa.name))
FROM parking_areas pa
WHERE pa.owner_id IS NULL
  AND (SELECT COUNT(*) FROM owners o WHERE o.name = pa.name) > 1
  AND NOT EXISTS (
    SELECT 1 FROM migration_conflicts mc
    WHERE mc.concern = 'parking_areas.owner_id' AND mc.entity_id = pa.id::text
  );

-- 2c. Orphaned: no owner claims this lot at all.
INSERT INTO migration_conflicts (migration, concern, entity_table, entity_id, reason, details)
SELECT '0005', 'parking_areas.owner_id', 'parking_areas', pa.id::text,
       'No owner record references this parking area name',
       jsonb_build_object('parking_area_name', pa.name)
FROM parking_areas pa
WHERE pa.owner_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM owners o WHERE o.name = pa.name)
  AND NOT EXISTS (
    SELECT 1 FROM migration_conflicts mc
    WHERE mc.concern = 'parking_areas.owner_id' AND mc.entity_id = pa.id::text
  );


-- ============================================================================
-- 3. parking_areas: prices, slug, defaults
-- ============================================================================

-- base_car_price / base_bike_price were read by the pricing engine and written by
-- nothing. If the columns exist, carry them across as paise; otherwise use the
-- documented fallbacks (₹20 car, ₹10 bike).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'parking_areas' AND column_name = 'base_car_price'
  ) THEN
    EXECUTE $sql$
      UPDATE parking_areas
      SET base_car_price_paise = ROUND(base_car_price * 100)::integer
      WHERE base_car_price_paise IS NULL AND base_car_price IS NOT NULL AND base_car_price > 0
    $sql$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'parking_areas' AND column_name = 'base_bike_price'
  ) THEN
    EXECUTE $sql$
      UPDATE parking_areas
      SET base_bike_price_paise = ROUND(base_bike_price * 100)::integer
      WHERE base_bike_price_paise IS NULL AND base_bike_price IS NOT NULL AND base_bike_price > 0
    $sql$;
  END IF;
END $$;

UPDATE parking_areas SET base_car_price_paise  = 2000 WHERE base_car_price_paise  IS NULL;
UPDATE parking_areas SET base_bike_price_paise = 1000 WHERE base_bike_price_paise IS NULL;

-- URL-safe slug, uniquified by id so two lots with the same name never collide.
UPDATE parking_areas
SET slug = regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g') || '-' || id::text
WHERE slug IS NULL AND name IS NOT NULL;


-- ============================================================================
-- 4. parking_slots ← materialised from total_car_slots / total_bike_slots
--
-- Rows are laid out 8 per row (A1..A8, B1..B8, …), which is what lets the client
-- render a real layout instead of inventing lanes with `slot_number <= 6`.
-- ============================================================================
INSERT INTO parking_slots (parking_area_id, vehicle_type, code, row_label, position,
                           slot_number, is_active)
SELECT
  pa.id,
  v.vehicle_type,
  chr(65 + ((n - 1) / 8)) || (((n - 1) % 8) + 1)::text,   -- A1 … A8, B1 …
  chr(65 + ((n - 1) / 8)),
  ((n - 1) % 8) + 1,
  n,
  true
FROM parking_areas pa
CROSS JOIN LATERAL (
  VALUES ('car', COALESCE(pa.total_car_slots, 0)),
         ('bike', COALESCE(pa.total_bike_slots, 0))
) AS v(vehicle_type, total)
CROSS JOIN LATERAL generate_series(1, GREATEST(v.total, 0)) AS n
WHERE v.total > 0
ON CONFLICT (parking_area_id, vehicle_type, slot_number) DO NOTHING;


-- ============================================================================
-- 5. bookings
-- ============================================================================

-- 5a. user_id ← phone. Unmatched phones are reported, not invented.
UPDATE bookings b
SET user_id = u.id
FROM users u
WHERE b.user_id IS NULL
  AND b.phone IS NOT NULL AND b.phone <> ''
  AND u.phone = b.phone;

INSERT INTO migration_conflicts (migration, concern, entity_table, entity_id, reason, details)
SELECT '0005', 'bookings.user_id', 'bookings', b.id::text,
       'Booking phone does not match any user record',
       jsonb_build_object('phone_suffix', right(b.phone, 3))
FROM bookings b
WHERE b.user_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM migration_conflicts mc
    WHERE mc.concern = 'bookings.user_id' AND mc.entity_id = b.id::text
  );

-- 5b. parking_slot_id ← (parking_id, vehicle_type, slot_number)
UPDATE bookings b
SET parking_slot_id = ps.id
FROM parking_slots ps
WHERE b.parking_slot_id IS NULL
  AND ps.parking_area_id = b.parking_id
  AND ps.vehicle_type    = lower(b.vehicle_type)
  AND ps.slot_number     = b.slot_number;

-- 5c. status ← is_verified / exit_time.
--     Live `bookings` rows are all active in the old model: completed and cancelled
--     bookings were DELETEd and copied to booking_history.
UPDATE bookings
SET status = CASE
  WHEN exit_time IS NOT NULL          THEN 'COMPLETED'
  WHEN is_verified IS TRUE            THEN 'CONFIRMED'
  ELSE                                     'PENDING_PAYMENT'
END
WHERE status IS NULL;

-- 5d. Money to integer paise.
UPDATE bookings
SET amount_paise = ROUND(COALESCE(amount, 0) * 100)::integer
WHERE amount_paise IS NULL;

-- 5e. Duration. The old model had none — only entry_time plus an assumed window.
--     One hour is the documented default; the value is explicit from now on.
UPDATE bookings SET duration_minutes = 60 WHERE duration_minutes IS NULL;

UPDATE bookings
SET expected_exit_time = entry_time + make_interval(mins => duration_minutes)
WHERE expected_exit_time IS NULL AND entry_time IS NOT NULL;

-- 5f. Lifecycle timestamps inferable from existing columns.
UPDATE bookings SET checked_in_at = verified_at
WHERE checked_in_at IS NULL AND verified_at IS NOT NULL AND status IN ('CHECKED_IN', 'COMPLETED');

UPDATE bookings SET completed_at = exit_time
WHERE completed_at IS NULL AND exit_time IS NOT NULL;

-- 5g. User-facing booking codes.
UPDATE bookings SET booking_code = generate_booking_code(id) WHERE booking_code IS NULL;

-- 5h. Every pre-existing booking came from the customer or owner app.
UPDATE bookings SET source = 'legacy' WHERE source = 'customer_app' AND created_at < NOW();


-- ============================================================================
-- 6. booking_history → bookings
--
-- Gives the new app one source of truth for a customer's history. Archived rows are
-- inserted as terminal-status bookings with NEW ids; the original row is stamped
-- with migrated_to_booking_id, which makes this re-runnable and auditable.
-- No history row is modified beyond that stamp, and none is deleted.
-- ============================================================================
WITH inserted AS (
  INSERT INTO bookings (
    parking_id, slot_number, vehicle_type, slot_id, number_plate, phone,
    entry_time, exit_time, payment_id, amount, is_verified, verified_at,
    created_at, updated_at,
    status, user_id, parking_slot_id, duration_minutes, expected_exit_time,
    amount_paise, final_amount_paise, completed_at, cancelled_at, source
  )
  SELECT
    bh.parking_id,
    COALESCE(bh.slot_number, 0),
    COALESCE(lower(bh.vehicle_type), 'car'),
    bh.slot_id,
    COALESCE(bh.number_plate, ''),
    COALESCE(bh.phone, ''),
    bh.entry_time,
    bh.exit_time,
    COALESCE(bh.payment_id, ''),
    COALESCE(bh.amount, 0),
    NOT COALESCE(bh.not_verified, true),
    bh.verified_at,
    COALESCE(bh.archived_at, NOW()),
    NOW(),
    CASE WHEN COALESCE(bh.cancelled, false) THEN 'CANCELLED' ELSE 'COMPLETED' END,
    (SELECT u.id FROM users u WHERE u.phone = bh.phone),
    (SELECT ps.id FROM parking_slots ps
      WHERE ps.parking_area_id = bh.parking_id
        AND ps.vehicle_type = lower(COALESCE(bh.vehicle_type, 'car'))
        AND ps.slot_number = bh.slot_number),
    60,
    bh.entry_time + make_interval(mins => 60),
    ROUND(COALESCE(bh.amount, 0) * 100)::integer,
    ROUND(COALESCE(bh.amount, 0) * 100)::integer,
    CASE WHEN COALESCE(bh.cancelled, false) THEN NULL ELSE bh.exit_time END,
    bh.cancelled_at,
    'legacy_history'
  FROM booking_history bh
  WHERE bh.migrated_to_booking_id IS NULL
    AND bh.parking_id IS NOT NULL
  RETURNING id, booking_code, created_at
)
SELECT count(*) FROM inserted;

-- Stamp the source rows. Matching is by (parking_id, entry_time, phone) on the rows
-- just inserted with source='legacy_history'.
UPDATE booking_history bh
SET migrated_to_booking_id = b.id,
    migrated_at = NOW()
FROM bookings b
WHERE bh.migrated_to_booking_id IS NULL
  AND b.source = 'legacy_history'
  AND b.parking_id = bh.parking_id
  AND b.phone IS NOT DISTINCT FROM COALESCE(bh.phone, '')
  AND b.entry_time IS NOT DISTINCT FROM bh.entry_time
  AND b.slot_number = COALESCE(bh.slot_number, 0);

-- Codes for the newly-inserted history rows.
UPDATE bookings SET booking_code = generate_booking_code(id) WHERE booking_code IS NULL;


-- ============================================================================
-- 7. Seed the audit trail so every booking has an origin event
-- ============================================================================
INSERT INTO booking_events (booking_id, event_type, from_status, to_status, actor_type, metadata)
SELECT b.id, 'migrated', NULL, b.status, 'system',
       jsonb_build_object('migration', '0005', 'source', b.source)
FROM bookings b
WHERE NOT EXISTS (
  SELECT 1 FROM booking_events be WHERE be.booking_id = b.id AND be.event_type = 'migrated'
);


-- ============================================================================
-- 8. slot_holds: link to users and slots
-- ============================================================================
UPDATE slot_holds sh
SET user_id = u.id
FROM users u
WHERE sh.user_id IS NULL AND u.phone = sh.phone;

UPDATE slot_holds sh
SET parking_slot_id = ps.id
FROM parking_slots ps
WHERE sh.parking_slot_id IS NULL
  AND ps.parking_area_id = sh.parking_id
  AND ps.vehicle_type    = lower(sh.vehicle_type)
  AND ps.slot_number     = sh.slot_number;


-- ============================================================================
-- 9. Recompute availability counters from reality
--
-- available_*_slots was maintained by ±1 increments with no ceiling, so it drifted:
-- double verification decremented twice, and the capacity reset deleted verified
-- bookings without restoring counts. Recomputing here gives one correct starting
-- point; the new code derives availability rather than maintaining a counter.
-- ============================================================================
UPDATE parking_areas pa
SET
  booked_car_slots = COALESCE(c.car_booked, 0),
  booked_bike_slots = COALESCE(c.bike_booked, 0),
  available_car_slots  = GREATEST(COALESCE(pa.total_car_slots, 0)  - COALESCE(c.car_booked, 0), 0),
  available_bike_slots = GREATEST(COALESCE(pa.total_bike_slots, 0) - COALESCE(c.bike_booked, 0), 0)
FROM (
  SELECT
    parking_id,
    COUNT(*) FILTER (WHERE vehicle_type = 'car')  AS car_booked,
    COUNT(*) FILTER (WHERE vehicle_type = 'bike') AS bike_booked
  FROM bookings
  WHERE status IN ('CONFIRMED', 'CHECKED_IN')
  GROUP BY parking_id
) c
WHERE pa.id = c.parking_id;

-- Lots with no active bookings at all.
UPDATE parking_areas pa
SET booked_car_slots = 0, booked_bike_slots = 0,
    available_car_slots = COALESCE(pa.total_car_slots, 0),
    available_bike_slots = COALESCE(pa.total_bike_slots, 0)
WHERE NOT EXISTS (
  SELECT 1 FROM bookings b
  WHERE b.parking_id = pa.id AND b.status IN ('CONFIRMED', 'CHECKED_IN')
);


-- ============================================================================
-- 10. Report
-- ============================================================================
DO $$
DECLARE
  v_owners        bigint;
  v_areas_linked  bigint;
  v_areas_total   bigint;
  v_slots         bigint;
  v_bookings      bigint;
  v_conflicts     bigint;
BEGIN
  SELECT COUNT(*) INTO v_owners       FROM owners;
  SELECT COUNT(*) INTO v_areas_linked FROM parking_areas WHERE owner_id IS NOT NULL;
  SELECT COUNT(*) INTO v_areas_total  FROM parking_areas;
  SELECT COUNT(*) INTO v_slots        FROM parking_slots;
  SELECT COUNT(*) INTO v_bookings     FROM bookings WHERE status IS NOT NULL;
  SELECT COUNT(*) INTO v_conflicts    FROM migration_conflicts WHERE resolved_at IS NULL;

  RAISE NOTICE '0005 backfill complete';
  RAISE NOTICE '  owners:            %', v_owners;
  RAISE NOTICE '  parking areas:     % of % linked to an owner', v_areas_linked, v_areas_total;
  RAISE NOTICE '  parking slots:     %', v_slots;
  RAISE NOTICE '  bookings w/ status:%', v_bookings;
  RAISE NOTICE '  OPEN CONFLICTS:    %  <- must be 0 before migration 0007', v_conflicts;

  IF v_conflicts > 0 THEN
    RAISE NOTICE 'Review with: SELECT concern, reason, COUNT(*) FROM migration_conflicts '
                 'WHERE resolved_at IS NULL GROUP BY 1,2;';
  END IF;
END $$;
