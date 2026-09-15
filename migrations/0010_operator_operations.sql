-- ============================================================================
-- 0010  Operator operations
--
-- Additive, like every migration before it. Two things the operator surface needs
-- that nothing so far provides:
--
--   1. A booking-code lookup that is actually indexed. The code is designed to be
--      read aloud at a barrier, so the operator types it in whatever case they
--      like — but `WHERE upper(booking_code) = upper($1)` cannot use the plain
--      unique index from 0004, and would sequentially scan the bookings table on
--      every arrival. At a busy lot that is the single hottest query in the system.
--
--   2. An audit trail for configuration changes. `booking_events` records what
--      happens to a booking; nothing records that an operator took slot A12 out of
--      service, or changed a price, or reduced capacity. Those are exactly the
--      actions a customer later disputes.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Indexed, case-insensitive booking-code lookup
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bookings_code_upper
  ON bookings (upper(booking_code))
  WHERE booking_code IS NOT NULL;

COMMENT ON INDEX idx_bookings_code_upper IS
  'Supports the operator arrival lookup, which upper-cases both sides so an operator '
  'can type a code in any case. The plain unique index on booking_code cannot serve it.';


-- Arrivals board: "who is due in the next 30 minutes at this lot".
CREATE INDEX IF NOT EXISTS idx_bookings_area_entry_status
  ON bookings (parking_id, entry_time)
  WHERE status IN ('CONFIRMED', 'CHECKED_IN', 'PENDING_PAYMENT');

-- Plate lookup, for the case where a driver has lost their code but is standing in
-- front of the operator with the car.
CREATE INDEX IF NOT EXISTS idx_bookings_plate_upper
  ON bookings (upper(replace(number_plate, ' ', '')))
  WHERE number_plate IS NOT NULL AND number_plate <> '';


-- ----------------------------------------------------------------------------
-- parking_audit_events — append-only record of operator configuration changes
--
-- Deliberately separate from booking_events: that table is keyed on a booking and
-- cascades with it. A record of "capacity was reduced on this date, by this person,
-- affecting these reservations" must outlive any individual booking.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parking_audit_events (
  id              bigserial PRIMARY KEY,
  parking_area_id bigint      NOT NULL,
  -- Who did it. NULL means the system (a sweeper, a migration).
  owner_id        bigint,
  event_type      text        NOT NULL,
  -- Free-form but structured: { from: …, to: …, affected_bookings: [...] }.
  -- Enough to answer "what did this change actually do" months later.
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_parking_audit_type CHECK (
    event_type IN (
      'slot_closed', 'slot_reopened',
      'capacity_increased', 'capacity_reduced', 'capacity_reduction_blocked',
      'pricing_changed', 'hours_changed', 'details_changed',
      'amenities_changed', 'lot_activated', 'lot_deactivated'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_parking_audit_area
  ON parking_audit_events (parking_area_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parking_audit_type
  ON parking_audit_events (event_type, created_at DESC);

COMMENT ON TABLE parking_audit_events IS
  'Append-only. Records operator configuration changes, which booking_events cannot: '
  'it is keyed on a booking and cascades away with it.';


-- ----------------------------------------------------------------------------
-- Foreign keys, conditional like every other constraint in this schema.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('add_constraint_if_absent(text,text,text)') IS NOT NULL THEN
    PERFORM add_constraint_if_absent('parking_audit_events', 'fk_parking_audit_area',
      'FOREIGN KEY (parking_area_id) REFERENCES parking_areas(id) ON DELETE CASCADE');
    PERFORM add_constraint_if_absent('parking_audit_events', 'fk_parking_audit_owner',
      'FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE SET NULL');
  ELSE
    RAISE NOTICE 'SKIPPED 0010 constraints: run 0007 first.';
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- Report
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_unowned bigint;
BEGIN
  -- An operator can only be shown lots they own. Any lot with no owner_id is
  -- invisible to the operator app, which is the safe failure but worth naming.
  SELECT COUNT(*) INTO v_unowned FROM parking_areas WHERE owner_id IS NULL AND is_active;

  IF v_unowned > 0 THEN
    RAISE NOTICE '0010: % active parking areas have no owner_id and will not appear in '
                 'any operator account. Resolve migration_conflicts for '
                 '''parking_areas.owner_id'' before operators go live.', v_unowned;
  END IF;

  RAISE NOTICE '0010 complete — operator operations schema in place.';
END $$;
