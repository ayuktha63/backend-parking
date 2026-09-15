-- ============================================================================
-- 0003  Base tables, created only if absent
--
-- On the live database every one of these already exists and this migration is a
-- no-op. Its purpose is to let a developer create a working database from an empty
-- one, which was previously impossible: the schema existed only inside the hosted
-- Neon instance and no repository contained a single CREATE TABLE.
--
-- Column definitions mirror the shapes inferred from the legacy server's SQL, so a
-- freshly-created database behaves identically to production. 0004 then brings both
-- to the same target schema.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id          bigserial PRIMARY KEY,
  phone       text        NOT NULL,
  name        text        NOT NULL DEFAULT 'User',
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users (phone);


-- The owners table of the MongoDB era. Superseded by `owners` (0002); retained
-- because the legacy /api/owner/* routes still read it until clients migrate.
CREATE TABLE IF NOT EXISTS register_login (
  id                bigserial PRIMARY KEY,
  phone             text        NOT NULL,
  parking_area_name text,
  password          text,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_register_login_phone ON register_login (phone);


CREATE TABLE IF NOT EXISTS parking_areas (
  id                   bigserial PRIMARY KEY,
  name                 text        NOT NULL,
  lat                  double precision,
  lng                  double precision,
  total_car_slots      integer     NOT NULL DEFAULT 0,
  available_car_slots  integer     NOT NULL DEFAULT 0,
  booked_car_slots     integer     NOT NULL DEFAULT 0,
  total_bike_slots     integer     NOT NULL DEFAULT 0,
  available_bike_slots integer     NOT NULL DEFAULT 0,
  booked_bike_slots    integer     NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT NOW(),
  updated_at           timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parking_areas_name ON parking_areas (name);


CREATE TABLE IF NOT EXISTS bookings (
  id           bigserial PRIMARY KEY,
  parking_id   bigint      NOT NULL,
  slot_number  integer     NOT NULL,
  vehicle_type text        NOT NULL,
  slot_id      bigint,
  number_plate text        NOT NULL DEFAULT '',
  phone        text        NOT NULL DEFAULT '',
  entry_time   timestamptz,
  exit_time    timestamptz,
  payment_id   text        NOT NULL DEFAULT '',
  amount       numeric(12, 2) NOT NULL DEFAULT 0,
  is_verified  boolean     NOT NULL DEFAULT false,
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bookings_area_vehicle ON bookings (parking_id, vehicle_type);
CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings (phone);


CREATE TABLE IF NOT EXISTS booking_history (
  id             bigserial PRIMARY KEY,
  booking_id     bigint,
  parking_id     bigint,
  slot_id        bigint,
  slot_number    integer,
  phone          text,
  vehicle_type   text,
  number_plate   text,
  entry_time     timestamptz,
  exit_time      timestamptz,
  payment_id     text,
  amount         numeric(12, 2) DEFAULT 0,
  archived_at    timestamptz NOT NULL DEFAULT NOW(),
  cancelled      boolean,
  cancelled_at   timestamptz,
  refund_percent integer,
  refund_amount  numeric(12, 2),
  not_verified   boolean,
  verified_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_booking_history_phone ON booking_history (phone);


CREATE TABLE IF NOT EXISTS slot_holds (
  id              bigserial PRIMARY KEY,
  parking_id      bigint      NOT NULL,
  slot_number     integer     NOT NULL,
  vehicle_type    text        NOT NULL,
  phone           text        NOT NULL,
  hold_expires_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_slot_holds_lookup
  ON slot_holds (parking_id, vehicle_type, slot_number);


-- Write-only in the legacy design: upserted on booking, deleted on capacity change,
-- never read. Superseded by parking_slots (0002); renamed in 0008, never dropped.
CREATE TABLE IF NOT EXISTS slots (
  id             bigserial PRIMARY KEY,
  parking_id     bigint      NOT NULL,
  slot_number    integer     NOT NULL,
  vehicle_type   text        NOT NULL,
  last_booked_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  updated_at     timestamptz NOT NULL DEFAULT NOW()
);
-- The legacy INSERT ... ON CONFLICT (parking_id, vehicle_type, slot_number) in
-- processBooking requires this exact unique index to exist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_slots_area_type_number
  ON slots (parking_id, vehicle_type, slot_number);
