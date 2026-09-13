-- ============================================================================
-- 0006  Indexes  (runs OUTSIDE a transaction — note the .nontx.sql suffix)
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so the runner
-- executes this file directly. Every statement uses IF NOT EXISTS, which makes the
-- file safe to re-run if it fails partway.
--
-- These cover the queries that run on every screen load and the two sweepers that
-- run every 5 and 30 seconds forever. The previous schema defined no indexes at all
-- beyond primary keys, and the repository contained no CREATE INDEX statement.
-- ============================================================================

-- ── Slot availability: the hottest read in the system ────────────────────────
-- Hit on every slot-map load and on every owner dashboard refresh.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_area_type_status_time
  ON bookings (parking_id, vehicle_type, status, entry_time);

-- Conflict detection for a specific slot and window.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_slot_window
  ON bookings (parking_slot_id, entry_time, expected_exit_time)
  WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN');

-- ── Customer booking list ────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_user_created
  ON bookings (user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_user_status
  ON bookings (user_id, status, entry_time DESC);

-- Legacy routes still look bookings up by phone string.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_phone_created
  ON bookings (phone, created_at DESC);

-- ── Sweepers ─────────────────────────────────────────────────────────────────
-- Hold sweeper, every 5 seconds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_holds_expiry_open
  ON slot_holds (hold_expires_at)
  WHERE consumed_at IS NULL AND released_at IS NULL;

-- Pending-payment sweeper, every 30 seconds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_pending_created
  ON bookings (created_at)
  WHERE status = 'PENDING_PAYMENT';

-- No-show sweeper.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_confirmed_exit
  ON bookings (expected_exit_time)
  WHERE status = 'CONFIRMED';

-- ── Discovery ────────────────────────────────────────────────────────────────
-- Bounding-box queries for the map ("search this area") and nearby search.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parking_areas_location
  ON parking_areas (lat, lng)
  WHERE is_active AND lat IS NOT NULL AND lng IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parking_areas_popularity
  ON parking_areas (popularity_score DESC, rating_avg DESC NULLS LAST)
  WHERE is_active;

-- Text search over lot name, locality and city.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parking_areas_search
  ON parking_areas
  USING gin (to_tsvector('simple',
    coalesce(name, '') || ' ' || coalesce(locality, '') || ' ' ||
    coalesce(city, '') || ' ' || coalesce(landmark, '')));

-- Prefix/substring matching for search-as-you-type. Requires pg_trgm; skipped
-- silently if the extension is unavailable.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_parking_areas_name_trgm '
          'ON parking_areas USING gin (name gin_trgm_ops)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable; search-as-you-type falls back to prefix matching.';
END $$;

-- ── Owner dashboard ──────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_area_status_created
  ON bookings (parking_id, status, created_at DESC);

-- Today's revenue: completed bookings in a date range.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_completed_at
  ON bookings (parking_id, completed_at DESC)
  WHERE status = 'COMPLETED';

-- ── Auth ─────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otp_phone_purpose_created
  ON otp_requests (phone, purpose, created_at DESC);

-- ── Payments ─────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_booking_status
  ON payments (booking_id, status);
