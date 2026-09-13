-- ============================================================================
-- 0009  Booking engine
--
-- Everything Phase 3 needs that 0002–0007 did not already provide. Additive and
-- idempotent, like every migration before it: no column is dropped, no row is
-- deleted, and re-running changes nothing.
--
-- Three concerns:
--   1. IDEMPOTENCY. A booking request that is retried after a network drop must
--      produce the same booking, not a second one. Same for a payment order.
--   2. TRACEABILITY. Which hold became which booking, and which quote was shown
--      to the customer at the moment they agreed to pay.
--   3. THE ACCESS CREDENTIAL. What the driver shows at the barrier and what the
--      operator types in to find them.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- bookings — idempotency, provenance, check-out accounting
-- ----------------------------------------------------------------------------
ALTER TABLE bookings
  -- Client-generated UUID, unique per user. A retried create returns the original
  -- booking instead of making a second one. This is the only thing standing
  -- between a flaky connection and a customer paying twice.
  ADD COLUMN IF NOT EXISTS idempotency_key  text,
  -- Which hold this booking came from. Makes the hold→booking funnel measurable
  -- and lets a repeated confirm find the booking it already created.
  ADD COLUMN IF NOT EXISTS slot_hold_id     bigint,
  -- Set when the customer actually leaves. `final_amount_paise` (0004) carries
  -- reserved + any overstay; this records how that number was arrived at.
  ADD COLUMN IF NOT EXISTS checkout_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Who performed the check-in / check-out. NULL means the customer did it.
  ADD COLUMN IF NOT EXISTS checked_in_by_owner_id  bigint,
  ADD COLUMN IF NOT EXISTS checked_out_by_owner_id bigint,
  ADD COLUMN IF NOT EXISTS checked_out_at          timestamptz;

-- One booking per (user, idempotency key). Partial, so the millions of legacy rows
-- with no key do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_idempotency
  ON bookings (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_hold ON bookings (slot_hold_id)
  WHERE slot_hold_id IS NOT NULL;

-- The two queries the Bookings tab and the operator dashboard actually run.
CREATE INDEX IF NOT EXISTS idx_bookings_user_status
  ON bookings (user_id, status, entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_area_window
  ON bookings (parking_id, entry_time)
  WHERE status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN');

COMMENT ON COLUMN bookings.idempotency_key IS
  'Client-supplied UUID. Retrying a create with the same key returns the original booking.';


-- ----------------------------------------------------------------------------
-- payments — idempotency and reconciliation
-- ----------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  -- Set the first time a terminal state is reached, so a webhook and a client
  -- callback racing each other cannot both "settle" the same payment.
  ADD COLUMN IF NOT EXISTS settled_at      timestamptz,
  -- 'client_callback' | 'webhook' | 'reconciliation'. Which path got there first;
  -- purely diagnostic, but the first thing anyone asks during a dispute.
  ADD COLUMN IF NOT EXISTS settled_via     text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency
  ON payments (booking_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- At most one live order per booking. A second attempt reuses or supersedes the
-- first rather than creating a parallel order the customer could also pay.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_one_open_per_booking
  ON payments (booking_id)
  WHERE status IN ('CREATED', 'AUTHORIZED');


-- ----------------------------------------------------------------------------
-- slot_holds — extension accounting
-- ----------------------------------------------------------------------------
ALTER TABLE slot_holds
  ADD COLUMN IF NOT EXISTS extension_count integer NOT NULL DEFAULT 0,
  -- The quote shown alongside the countdown. Stored so the Review screen and the
  -- payment order cannot disagree about the price, even across an app restart.
  ADD COLUMN IF NOT EXISTS quote_snapshot  jsonb   NOT NULL DEFAULT '{}'::jsonb;


-- ----------------------------------------------------------------------------
-- Booking access credential
--
-- `booking_code` (0004) is what the driver shows and the operator searches for.
-- It is generated server-side from a restricted alphabet: no O/0, no I/1, so a
-- code read aloud at a barrier or typed from a phone screen is unambiguous.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_booking_code() RETURNS text
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  alphabet CONSTANT text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  candidate text;
  i integer;
BEGIN
  LOOP
    candidate := 'PQX-';
    FOR i IN 1..6 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM bookings WHERE booking_code = candidate);
  END LOOP;
  RETURN candidate;
END;
$$;

COMMENT ON FUNCTION generate_booking_code() IS
  'PQX-XXXXXX from an unambiguous alphabet. Replaces the old success screen''s '
  'Random().nextInt(9000), which was client-side and changed on every rebuild.';


-- ----------------------------------------------------------------------------
-- Foreign keys, conditional like every other constraint in this schema.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('add_constraint_if_absent(text,text,text)') IS NOT NULL THEN
    PERFORM add_constraint_if_absent('bookings', 'fk_bookings_hold',
      'FOREIGN KEY (slot_hold_id) REFERENCES slot_holds(id) ON DELETE SET NULL');
    PERFORM add_constraint_if_absent('payments', 'chk_payments_settled_via',
      $c$CHECK (settled_via IS NULL OR settled_via IN ('client_callback','webhook','reconciliation'))$c$);
    PERFORM add_constraint_if_absent('slot_holds', 'chk_holds_extension_count',
      'CHECK (extension_count >= 0)');
  ELSE
    RAISE NOTICE 'SKIPPED 0009 constraints: run 0007 first (add_constraint_if_absent is defined there).';
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- Report
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing_codes bigint;
BEGIN
  SELECT COUNT(*) INTO v_missing_codes
    FROM bookings
   WHERE booking_code IS NULL
     AND status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN');

  IF v_missing_codes > 0 THEN
    RAISE NOTICE '0009: % active bookings have no booking_code. '
                 'They were created before 0004; back-fill them with generate_booking_code() '
                 'before those customers next arrive at a barrier.', v_missing_codes;
  END IF;

  RAISE NOTICE '0009 complete — booking engine schema is in place.';
END $$;
