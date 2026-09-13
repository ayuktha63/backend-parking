-- ============================================================================
-- 0004  Extend existing tables — additive only
--
-- Every column here is added nullable or with a default, so currently-deployed
-- application builds continue to work unchanged. Nothing is dropped, renamed or
-- made NOT NULL; that happens in 0007, and only after 0005 has verified the data.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active      boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS phone_verified boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_login_at  timestamptz,
  -- Set once the user completes the first-run profile step.
  ADD COLUMN IF NOT EXISTS onboarded_at   timestamptz;

SELECT attach_updated_at('users');


-- ----------------------------------------------------------------------------
-- parking_areas
--
-- owner_id replaces the string match on parking_area_name = parking_areas.name,
-- which meant two owners typing the same lot name silently shared one row.
-- The rest are the fields the customer app already tries to read and that no
-- endpoint has ever returned.
-- ----------------------------------------------------------------------------
ALTER TABLE parking_areas
  ADD COLUMN IF NOT EXISTS owner_id                bigint,
  ADD COLUMN IF NOT EXISTS slug                    text,
  ADD COLUMN IF NOT EXISTS description             text,
  ADD COLUMN IF NOT EXISTS address_line            text,
  ADD COLUMN IF NOT EXISTS locality                text,
  ADD COLUMN IF NOT EXISTS city                    text,
  ADD COLUMN IF NOT EXISTS state                   text,
  ADD COLUMN IF NOT EXISTS postal_code             text,
  ADD COLUMN IF NOT EXISTS landmark                text,
  ADD COLUMN IF NOT EXISTS contact_phone           text,
  -- Prices in paise. `amount`/`base_*_price` in the old schema mixed rupee floats
  -- with integers and a hardcoded client-side ₹1.
  ADD COLUMN IF NOT EXISTS base_car_price_paise    integer,
  ADD COLUMN IF NOT EXISTS base_bike_price_paise   integer,
  -- Denormalised review aggregates, maintained by the review service.
  ADD COLUMN IF NOT EXISTS rating_avg              numeric(3, 2),
  ADD COLUMN IF NOT EXISTS rating_count            integer     NOT NULL DEFAULT 0,
  -- Used to rank "Popular" — the app already reads popularity_score and always got 0.
  ADD COLUMN IF NOT EXISTS popularity_score        integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_active               boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_open_24_7            boolean     NOT NULL DEFAULT true,
  -- Minutes east of UTC. Owner "today" metrics use the lot's local day, so a lot
  -- closing at 23:00 IST does not have its takings split across two UTC days.
  ADD COLUMN IF NOT EXISTS timezone_offset_minutes integer     NOT NULL DEFAULT 330,
  ADD COLUMN IF NOT EXISTS max_duration_minutes    integer,
  ADD COLUMN IF NOT EXISTS instructions            text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_parking_areas_slug
  ON parking_areas (slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_parking_areas_owner ON parking_areas (owner_id);
CREATE INDEX IF NOT EXISTS idx_parking_areas_active
  ON parking_areas (is_active) WHERE is_active;

SELECT attach_updated_at('parking_areas');

COMMENT ON COLUMN parking_areas.owner_id IS
  'FK to owners. Backfilled in 0005 by name match; ambiguities are logged to migration_conflicts and left NULL.';


-- ----------------------------------------------------------------------------
-- bookings
--
-- The big one. Adds:
--   status            an explicit lifecycle, replacing is_verified + row deletion
--   user_id           a real relationship, replacing the phone string
--   parking_slot_id   a real slot, replacing a bare integer
--   duration/exit     bookings previously had no duration at all: only entry_time
--                     plus a hardcoded ±10 min window and an assumed 15 minutes
--   amount_paise      integer money
--   booking_code      the user-facing reference (PQX-XXXXXX); the old success screen
--                     displayed `1000 + Random().nextInt(9000)`, regenerated on rebuild
-- ----------------------------------------------------------------------------
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS status             text,
  ADD COLUMN IF NOT EXISTS user_id            bigint,
  ADD COLUMN IF NOT EXISTS vehicle_id         bigint,
  ADD COLUMN IF NOT EXISTS parking_slot_id    bigint,
  ADD COLUMN IF NOT EXISTS booking_code       text,
  ADD COLUMN IF NOT EXISTS duration_minutes   integer,
  ADD COLUMN IF NOT EXISTS expected_exit_time timestamptz,
  ADD COLUMN IF NOT EXISTS amount_paise       integer,
  ADD COLUMN IF NOT EXISTS final_amount_paise integer,
  ADD COLUMN IF NOT EXISTS currency           text        NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS pricing_snapshot   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS checked_in_at      timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at       timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by       text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  -- Walk-ins are created by an operator but belong to the driver.
  ADD COLUMN IF NOT EXISTS created_by_owner_id bigint,
  ADD COLUMN IF NOT EXISTS source             text        NOT NULL DEFAULT 'customer_app',
  ADD COLUMN IF NOT EXISTS notes              text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_code
  ON bookings (booking_code) WHERE booking_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_user   ON bookings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_slot   ON bookings (parking_slot_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status, entry_time);

SELECT attach_updated_at('bookings');

COMMENT ON COLUMN bookings.status IS
  'PENDING_PAYMENT | CONFIRMED | CHECKED_IN | COMPLETED | CANCELLED | NO_SHOW | EXPIRED. '
  'Replaces is_verified plus row deletion. No terminal state deletes a row.';
COMMENT ON COLUMN bookings.amount_paise IS
  'Integer paise, computed server-side at order creation. The client never supplies an amount.';


-- ----------------------------------------------------------------------------
-- booking_history
--
-- Retained read-only for the legacy routes. New code reads `bookings` filtered by
-- status; nothing new is ever written here.
-- ----------------------------------------------------------------------------
ALTER TABLE booking_history
  ADD COLUMN IF NOT EXISTS migrated_to_booking_id bigint,
  ADD COLUMN IF NOT EXISTS migrated_at            timestamptz;

COMMENT ON TABLE booking_history IS
  'DEPRECATED. Legacy archive table. New lifecycle uses bookings.status + booking_events. '
  'Read-only after 0005 backfill.';


-- ----------------------------------------------------------------------------
-- slot_holds
--
-- Gains real ownership (user_id) rather than a phone string, and a link to the
-- slot it actually holds.
-- ----------------------------------------------------------------------------
ALTER TABLE slot_holds
  ADD COLUMN IF NOT EXISTS user_id         bigint,
  ADD COLUMN IF NOT EXISTS owner_id        bigint,
  ADD COLUMN IF NOT EXISTS parking_slot_id bigint,
  ADD COLUMN IF NOT EXISTS entry_time      timestamptz,
  ADD COLUMN IF NOT EXISTS duration_minutes integer,
  ADD COLUMN IF NOT EXISTS consumed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS released_at     timestamptz,
  ADD COLUMN IF NOT EXISTS release_reason  text;

CREATE INDEX IF NOT EXISTS idx_slot_holds_active
  ON slot_holds (parking_slot_id)
  WHERE consumed_at IS NULL AND released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_slot_holds_user ON slot_holds (user_id);

COMMENT ON COLUMN slot_holds.consumed_at IS
  'Set when the hold becomes a booking. Holds are no longer deleted on conversion, '
  'so the funnel from hold to booking is measurable.';
