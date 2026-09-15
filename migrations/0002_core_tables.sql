-- ============================================================================
-- 0002  New tables
--
-- Purely additive: creates tables that did not exist. Nothing existing is touched,
-- so the currently-deployed apps are unaffected by this migration.
--
-- Every table here fixes something the old schema could not express:
--   owners            → a real owner entity, so parking areas stop being linked by name
--   vehicles          → saved vehicles, so plates stop being retyped per booking
--   otp_requests      → hashed, expiring, attempt-limited OTP (was an in-memory object)
--   refresh_tokens    → revocable sessions (there were no sessions at all)
--   parking_slots     → real slots, so the slot map can reflect a real layout
--   payments/refunds  → server-verified payment state (was a client-supplied string)
--   booking_events    → an audit trail, so no lifecycle step is ever silently deleted
-- ============================================================================


-- ----------------------------------------------------------------------------
-- owners — parking operators
--
-- Replaces `register_login`, whose name was a MongoDB-era artefact and whose
-- password column stored plaintext.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS owners (
  id                    bigserial PRIMARY KEY,
  phone                 text        NOT NULL,
  name                  text,
  email                 text,
  -- bcrypt hash. NULL is valid: OTP-only owners never set a password.
  password_hash         text,
  -- Set for every owner migrated from the plaintext-password era.
  must_reset_password   boolean     NOT NULL DEFAULT false,
  is_active             boolean     NOT NULL DEFAULT true,
  -- Kept so the legacy name-matching routes can still resolve during migration.
  legacy_register_login_id bigint,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_owners_phone ON owners (phone);
SELECT attach_updated_at('owners');

COMMENT ON COLUMN owners.password_hash IS 'bcrypt. Plaintext passwords from register_login are hashed during 0004 backfill.';


-- ----------------------------------------------------------------------------
-- vehicles — a customer's saved vehicles
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
  id            bigserial PRIMARY KEY,
  user_id       bigint      NOT NULL,
  vehicle_type  text        NOT NULL,
  number_plate  text        NOT NULL,
  label         text,                       -- "My car", "Office bike"
  is_default    boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vehicles_type CHECK (vehicle_type IN ('car', 'bike'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_user_plate
  ON vehicles (user_id, upper(replace(number_plate, ' ', '')));
CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles (user_id);
-- At most one default vehicle per user per vehicle type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_one_default
  ON vehicles (user_id, vehicle_type) WHERE is_default;
SELECT attach_updated_at('vehicles');


-- ----------------------------------------------------------------------------
-- otp_requests
--
-- Replaces `app.locals.otpStore = {}` — a plain in-process object with no expiry,
-- no attempt limit and no rate limit, whose contents were also returned in the
-- HTTP response as `debug_otp`.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text        NOT NULL,
  purpose       text        NOT NULL DEFAULT 'login',
  -- SHA-256 of (otp + pepper). The code itself is never stored.
  otp_hash      text        NOT NULL,
  attempts      integer     NOT NULL DEFAULT 0,
  max_attempts  integer     NOT NULL DEFAULT 5,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  -- For abuse investigation; not used for authorisation.
  request_ip    inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_otp_purpose CHECK (purpose IN ('login', 'owner_login', 'verify_phone'))
);

CREATE INDEX IF NOT EXISTS idx_otp_phone_active
  ON otp_requests (phone, created_at DESC)
  WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_otp_expiry ON otp_requests (expires_at);


-- ----------------------------------------------------------------------------
-- refresh_tokens — revocable sessions
--
-- Rotating: verifying a refresh token issues a new one and marks the old rotated.
-- Re-use of a rotated token is treated as theft and revokes the whole family.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one of user_id / owner_id is set.
  user_id       bigint,
  owner_id      bigint,
  role          text        NOT NULL,
  token_hash    text        NOT NULL,
  -- All tokens descended from one login share a family id.
  family_id     uuid        NOT NULL DEFAULT gen_random_uuid(),
  rotated_to    uuid,
  revoked_at    timestamptz,
  revoked_reason text,
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  device_label  text,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_refresh_role CHECK (role IN ('customer', 'owner')),
  CONSTRAINT chk_refresh_subject CHECK (
    (user_id IS NOT NULL AND owner_id IS NULL) OR
    (user_id IS NULL AND owner_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_refresh_token_hash ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_user   ON refresh_tokens (user_id)  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_owner  ON refresh_tokens (owner_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON refresh_tokens (expires_at);


-- ----------------------------------------------------------------------------
-- parking_slots — real, addressable slots
--
-- The old system had a `slots` table that was written and never read, while actual
-- slot identity was a bare integer generated per request from total_car_slots. That
-- made a truthful slot map impossible: the client invented lanes with
-- `slot_number <= 6 ? 'A' : 'B'`.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parking_slots (
  id              bigserial PRIMARY KEY,
  parking_area_id bigint      NOT NULL,
  vehicle_type    text        NOT NULL,
  -- Stable public label shown to users, e.g. "A12".
  code            text        NOT NULL,
  -- Layout: which row, and position within it. Drives the rendered slot map.
  row_label       text        NOT NULL DEFAULT 'A',
  position        integer     NOT NULL DEFAULT 1,
  -- Preserved so legacy slot_number-based routes keep working during migration.
  slot_number     integer     NOT NULL,
  slot_class      text        NOT NULL DEFAULT 'standard',
  is_active       boolean     NOT NULL DEFAULT true,
  -- Soft-close reason when an owner takes a slot out of service.
  closed_reason   text,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_slots_vehicle_type CHECK (vehicle_type IN ('car', 'bike')),
  CONSTRAINT chk_slots_class CHECK (slot_class IN ('standard', 'accessible', 'ev', 'compact', 'valet')),
  CONSTRAINT chk_slots_number_positive CHECK (slot_number > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_parking_slots_number
  ON parking_slots (parking_area_id, vehicle_type, slot_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_parking_slots_code
  ON parking_slots (parking_area_id, vehicle_type, code);
CREATE INDEX IF NOT EXISTS idx_parking_slots_area_active
  ON parking_slots (parking_area_id, vehicle_type) WHERE is_active;
SELECT attach_updated_at('parking_slots');

COMMENT ON COLUMN parking_slots.slot_number IS
  'Legacy 1-based number. Kept for compatibility with /api/* routes; new code uses id and code.';


-- ----------------------------------------------------------------------------
-- payments — server-verified payment state
--
-- The old system stored a client-supplied `payment_id` string on the booking and
-- treated any non-empty value as proof of payment.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                  bigserial PRIMARY KEY,
  booking_id          bigint      NOT NULL,
  user_id             bigint,
  provider            text        NOT NULL DEFAULT 'razorpay',
  -- Amount the ORDER was created for. The client never supplies this.
  amount_paise        integer     NOT NULL,
  currency            text        NOT NULL DEFAULT 'INR',
  status              text        NOT NULL DEFAULT 'CREATED',
  provider_order_id   text,
  provider_payment_id text,
  provider_signature  text,
  -- Set only once a signature has actually been verified server-side.
  verified_at         timestamptz,
  failure_reason      text,
  -- Raw provider payloads, for reconciliation and dispute handling.
  order_payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  verify_payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  amount_refunded_paise integer   NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payments_status CHECK (
    status IN ('CREATED', 'AUTHORIZED', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED')
  ),
  CONSTRAINT chk_payments_amount CHECK (amount_paise >= 0),
  CONSTRAINT chk_payments_refund_bound CHECK (amount_refunded_paise BETWEEN 0 AND amount_paise)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_order
  ON payments (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_payment
  ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments (booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments (status, created_at DESC);
SELECT attach_updated_at('payments');


-- ----------------------------------------------------------------------------
-- refunds
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refunds (
  id                 bigserial PRIMARY KEY,
  payment_id         bigint      NOT NULL,
  booking_id         bigint      NOT NULL,
  amount_paise       integer     NOT NULL,
  reason             text,
  status             text        NOT NULL DEFAULT 'PENDING',
  provider_refund_id text,
  -- PENDING while FEATURE_REFUNDS_ENABLED is off: the obligation is recorded even
  -- when the gateway call is not yet being made, so nothing is quietly forgotten.
  provider_payload   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  failure_reason     text,
  processed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  updated_at         timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_refunds_status CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  CONSTRAINT chk_refunds_amount CHECK (amount_paise >= 0)
);

CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds (payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_pending ON refunds (status) WHERE status = 'PENDING';
SELECT attach_updated_at('refunds');


-- ----------------------------------------------------------------------------
-- provider_webhook_events — idempotent webhook processing
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id           bigserial PRIMARY KEY,
  provider     text        NOT NULL DEFAULT 'razorpay',
  event_id     text        NOT NULL,
  event_type   text,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_provider_event
  ON provider_webhook_events (provider, event_id);


-- ----------------------------------------------------------------------------
-- booking_events — append-only audit trail
--
-- Every lifecycle transition is recorded. This is what allows the new system to
-- stop deleting booking rows on cancel, complete, sweep and capacity change.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_events (
  id           bigserial PRIMARY KEY,
  booking_id   bigint      NOT NULL,
  event_type   text        NOT NULL,
  from_status  text,
  to_status    text,
  -- Who caused it: 'customer' | 'owner' | 'system' | 'provider'
  actor_type   text        NOT NULL DEFAULT 'system',
  actor_id     text,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_booking_events_actor CHECK (
    actor_type IN ('customer', 'owner', 'system', 'provider')
  )
);

CREATE INDEX IF NOT EXISTS idx_booking_events_booking
  ON booking_events (booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_booking_events_type
  ON booking_events (event_type, created_at DESC);


-- ----------------------------------------------------------------------------
-- Parking area enrichment: photos, amenities, opening hours
--
-- The customer app already reads `photo_url`, `image` and `popularity_score` from
-- the API. None of those columns has ever existed, so every card showed the same
-- stock photo and "Popular Parking" sorted by a constant zero.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parking_photos (
  id              bigserial PRIMARY KEY,
  parking_area_id bigint      NOT NULL,
  url             text        NOT NULL,
  caption         text,
  sort_order      integer     NOT NULL DEFAULT 0,
  is_cover        boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parking_photos_area
  ON parking_photos (parking_area_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_parking_photos_cover
  ON parking_photos (parking_area_id) WHERE is_cover;


CREATE TABLE IF NOT EXISTS amenities (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  icon        text,
  sort_order  integer NOT NULL DEFAULT 0
);

INSERT INTO amenities (code, label, icon, sort_order) VALUES
  ('covered',     'Covered',          'umbrella',        10),
  ('cctv',        'CCTV',             'videocam',        20),
  ('security',    'Security staff',   'shield',          30),
  ('ev_charging', 'EV charging',      'ev_station',      40),
  ('valet',       'Valet',            'concierge',       50),
  ('accessible',  'Accessible',       'accessible',      60),
  ('open_24_7',   'Open 24/7',        'clock',           70),
  ('car_wash',    'Car wash',         'local_car_wash',  80),
  ('lift',        'Lift access',      'elevator',        90),
  ('washroom',    'Washroom',         'wc',             100)
ON CONFLICT (code) DO NOTHING;


CREATE TABLE IF NOT EXISTS parking_amenities (
  parking_area_id bigint NOT NULL,
  amenity_code    text   NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parking_area_id, amenity_code)
);


-- Opening hours, one row per weekday. Absent rows mean "closed that day";
-- a lot with no rows at all is treated as always open.
CREATE TABLE IF NOT EXISTS parking_opening_hours (
  id              bigserial PRIMARY KEY,
  parking_area_id bigint  NOT NULL,
  day_of_week     integer NOT NULL,   -- 0 = Sunday
  opens_at        time    NOT NULL,
  closes_at       time    NOT NULL,
  -- Lets a lot close after midnight, e.g. 06:00 → 02:00.
  closes_next_day boolean NOT NULL DEFAULT false,
  CONSTRAINT chk_hours_dow CHECK (day_of_week BETWEEN 0 AND 6)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_opening_hours_area_day
  ON parking_opening_hours (parking_area_id, day_of_week);


-- ----------------------------------------------------------------------------
-- reviews — ratings shown on cards and the detail page
--
-- Created now so the rating field on the parking card has a real source. A lot
-- with no reviews reports rating = NULL and the UI hides the row, rather than
-- inventing "4.6".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parking_reviews (
  id              bigserial PRIMARY KEY,
  parking_area_id bigint      NOT NULL,
  user_id         bigint      NOT NULL,
  booking_id      bigint,
  rating          integer     NOT NULL,
  comment         text,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5)
);

-- One review per booking; one per user per lot when not tied to a booking.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_booking
  ON parking_reviews (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_area ON parking_reviews (parking_area_id);
SELECT attach_updated_at('parking_reviews');
