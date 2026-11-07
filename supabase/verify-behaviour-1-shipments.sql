-- Behaviour checks for 0004_shipments.sql and 0005_parties.sql.
--
-- Runs after verify-behaviour.sql, which defines the `assert` helpers and the
-- organisation / membership / location fixtures these build on.

-- ---------------------------------------------------------------------------
-- shipments
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  org_b    uuid;
  loc_a1   uuid;
  loc_a2   uuid;
  loc_b    uuid;
  ship     uuid;
begin
  select id into loc_a1 from public.locations where org_id = org_a and name = 'Alpha Yard';
  select id into loc_a2 from public.locations where org_id = org_a and name = 'Alpha Depot';

  insert into public.organisations (name, slug, is_subscriber, created_by)
  values ('Rival Haulage', 'rival-haulage', true, owner_id)
  returning id into org_b;

  insert into public.locations (org_id, name, kind)
  values (org_b, 'Rival Depot', 'depot')
  returning id into loc_b;

  -- THE TENANCY PROOF. A shipment must not be able to name another
  -- organisation's depot as an endpoint: that would leak the depot's name and
  -- position to everyone who can read the shipment.
  perform public.assert_rejects(
    format(
      'insert into public.shipments (org_id, reference, origin_location_id, destination_location_id, created_by)
       values (%L, %L, %L, %L, %L)',
      org_a, 'CROSS-TENANT', loc_a1, loc_b, owner_id
    ),
    'a shipment cannot use another organisation''s location as an endpoint'
  );

  perform public.assert_rejects(
    format(
      'insert into public.shipments (org_id, reference, origin_location_id, destination_location_id, created_by)
       values (%L, %L, %L, %L, %L)',
      org_a, 'SAME-ENDS', loc_a1, loc_a1, owner_id
    ),
    'a shipment cannot start and end at the same place'
  );

  insert into public.shipments (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org_a, 'ALPHA-001', loc_a1, loc_a2, owner_id)
  returning id into ship;

  perform public.assert(
    (select status from public.shipments where id = ship) = 'planned',
    'a new shipment starts as planned'
  );

  perform public.assert_rejects(
    format(
      'insert into public.shipments (org_id, reference, origin_location_id, destination_location_id, created_by)
       values (%L, %L, %L, %L, %L)',
      org_a, '  alpha-001  ', loc_a1, loc_a2, owner_id
    ),
    'a duplicate reference is rejected, ignoring case and surrounding space'
  );

  perform public.assert_rejects(
    format('update public.shipments set cargo_value = -1 where id = %L', ship),
    'a negative cargo value is rejected'
  );

  perform public.assert_rejects(
    format(
      'update public.shipments set dispatched_at = now(), delivered_at = now() - interval ''2 days'' where id = %L',
      ship
    ),
    'a shipment cannot be delivered before it was dispatched'
  );

  -- `cargo_value` is nullable and null means NOT DISCLOSED, never zero.
  -- Summing a 0 into "value at risk" would understate the one number the
  -- board exists to show.
  perform public.assert(
    (select cargo_value from public.shipments where id = ship) is null,
    'an undisclosed cargo value is null, not 0'
  );

  -- Status follows the shipment's own timestamps rather than contradicting
  -- them.
  update public.shipments set dispatched_at = now() - interval '1 day' where id = ship;
  perform public.assert(
    (select status from public.shipments where id = ship) = 'in_transit',
    'setting dispatched_at moves a planned shipment to in_transit'
  );

  update public.shipments set delivered_at = now() where id = ship;
  perform public.assert(
    (select status from public.shipments where id = ship) = 'delivered',
    'setting delivered_at moves a shipment to delivered'
  );

  update public.shipments set cancelled_at = now() where id = ship;
  perform public.assert(
    (select status from public.shipments where id = ship) = 'cancelled',
    'cancellation wins over delivery'
  );

  -- Put it back so the checkpoint checks below work on a live shipment.
  update public.shipments
  set cancelled_at = null, delivered_at = null, status = 'in_transit'
  where id = ship;
end;
$$;


-- ---------------------------------------------------------------------------
-- checkpoints — the journey
-- ---------------------------------------------------------------------------

do $$
declare
  org_a uuid := (select id from public.organisations where slug = 'example-freight');
  org_b uuid := (select id from public.organisations where slug = 'rival-haulage');
  ship  uuid := (select id from public.shipments where reference = 'ALPHA-001');
  cp    uuid;
begin
  perform public.assert_rejects(
    format(
      'insert into public.checkpoints (org_id, shipment_id, sequence_no, kind, label)
       values (%L, %L, 100, ''pickup'', ''No times at all'')',
      org_a, ship
    ),
    'a checkpoint with neither a planned nor an actual time is rejected'
  );

  -- The composite FK: a checkpoint cannot claim a different tenant from its
  -- own shipment.
  perform public.assert_rejects(
    format(
      'insert into public.checkpoints (org_id, shipment_id, sequence_no, kind, label, planned_at)
       values (%L, %L, 100, ''pickup'', ''Mismatched tenant'', now())',
      org_b, ship
    ),
    'a checkpoint whose org disagrees with its shipment is rejected'
  );

  insert into public.checkpoints (org_id, shipment_id, sequence_no, kind, label, planned_at)
  values (org_a, ship, 100, 'pickup', 'Collect at Alpha Yard', now() - interval '2 days')
  returning id into cp;

  perform public.assert_rejects(
    format(
      'insert into public.checkpoints (org_id, shipment_id, sequence_no, kind, label, planned_at)
       values (%L, %L, 100, ''depot_in'', ''Duplicate sequence'', now())',
      org_a, ship
    ),
    'two checkpoints cannot share a sequence number on one shipment'
  );

  perform public.assert_rejects(
    format(
      'insert into public.checkpoints (org_id, shipment_id, sequence_no, kind, label, planned_at, latitude)
       values (%L, %L, 200, ''linehaul'', ''Half a pin'', now(), -26.1)',
      org_a, ship
    ),
    'a checkpoint with half a coordinate is rejected'
  );

  -- A pending checkpoint has witnessed nothing yet.
  perform public.assert(
    (select recorded_at from public.checkpoints where id = cp) is null,
    'a pending checkpoint has no recorded_at'
  );
  perform public.assert(
    (select last_event_at from public.shipments where id = ship) is null,
    'a planned-but-not-actual checkpoint does not count as an event'
  );
  perform public.assert(
    (select checkpoint_count from public.shipments where id = ship) = 1
      and (select cleared_checkpoint_count from public.shipments where id = ship) = 0,
    'the shipment counts the checkpoint, but not as cleared'
  );

  update public.checkpoints set actual_at = now() - interval '1 day' where id = cp;

  perform public.assert(
    (select recorded_at from public.checkpoints where id = cp) is not null,
    'clearing a checkpoint stamps recorded_at'
  );
  perform public.assert(
    (select cleared_checkpoint_count from public.shipments where id = ship) = 1,
    'clearing a checkpoint updates the shipment''s cleared count'
  );
  perform public.assert(
    (select last_event_at from public.shipments where id = ship)
      = (select actual_at from public.checkpoints where id = cp),
    'last_event_at follows the most recent actual checkpoint'
  );

  -- `recorded_at` records when the SYSTEM was told, so a caller may not choose
  -- it. The gap between actual_at and recorded_at is oversight information
  -- about the operation, and is worthless if it can be dictated.
  update public.checkpoints
  set actual_at = now() - interval '3 days',
      recorded_at = timestamptz '2000-01-01 00:00:00+02'
  where id = cp;
  perform public.assert(
    (select recorded_at from public.checkpoints where id = cp)
      <> timestamptz '2000-01-01 00:00:00+02',
    'a caller cannot dictate recorded_at'
  );

  -- Un-clearing must reverse all of it, or a mistaken scan leaves the board
  -- permanently wrong.
  update public.checkpoints set actual_at = null where id = cp;
  perform public.assert(
    (select recorded_at from public.checkpoints where id = cp) is null
      and (select cleared_checkpoint_count from public.shipments where id = ship) = 0
      and (select last_event_at from public.shipments where id = ship) is null,
    'un-clearing a checkpoint reverses recorded_at, the count and last_event_at'
  );

  delete from public.checkpoints where id = cp;
  perform public.assert(
    (select checkpoint_count from public.shipments where id = ship) = 0,
    'deleting a checkpoint reverses the shipment''s count'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- shipment_parties
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  org_b    uuid := (select id from public.organisations where slug = 'rival-haulage');
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  ship     uuid := (select id from public.shipments where reference = 'ALPHA-001');
begin
  perform public.assert_rejects(
    format(
      'insert into public.shipment_parties (org_id, shipment_id, party_org_id, party_role, granted_by)
       values (%L, %L, %L, ''consignee'', %L)',
      org_a, ship, org_a, owner_id
    ),
    'an organisation cannot be made a party to its own shipment'
  );

  insert into public.shipment_parties (org_id, shipment_id, party_org_id, party_role, granted_by)
  values (org_a, ship, org_b, 'consignee', owner_id);

  perform public.assert_rejects(
    format(
      'insert into public.shipment_parties (org_id, shipment_id, party_org_id, party_role, granted_by)
       values (%L, %L, %L, ''consignee'', %L)',
      org_a, ship, org_b, owner_id
    ),
    'the same organisation cannot hold the same live grant twice'
  );

  -- Revoking frees the slot, because the unique index is partial on
  -- `revoked_at is null`. Access can be granted again later without
  -- destroying the record that it was once withdrawn.
  update public.shipment_parties
  set revoked_at = now(), revoked_by = owner_id
  where shipment_id = ship and party_org_id = org_b;

  insert into public.shipment_parties (org_id, shipment_id, party_org_id, party_role, granted_by)
  values (org_a, ship, org_b, 'consignee', owner_id);

  perform public.assert(
    (select count(*) from public.shipment_parties where shipment_id = ship) = 2,
    'a revoked grant is kept as a record and a new one can be issued'
  );

  perform public.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'shipment_parties'
        and cmd in ('DELETE', 'ALL')
    ),
    'shipment_parties has no delete policy — grants are revoked, not erased'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- The cross-tenant predicates are locked down too
-- ---------------------------------------------------------------------------
-- These three decide who may read another organisation's shipment. They are
-- the most dangerous functions in the schema.

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'can_view_shipment', 'can_view_location', 'shares_shipment_with_org',
    'checkpoints_stamp_recorded', 'checkpoints_touch_shipment'
  ] loop
    perform public.assert(
      exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn and p.prosecdef
          and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
      ),
      format('%s is security definer with a pinned search_path', fn)
    );
  end loop;

  foreach fn in array array['can_view_shipment', 'can_view_location', 'shares_shipment_with_org'] loop
    perform public.assert(
      not has_function_privilege('anon', (
        select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn limit 1
      ), 'execute'),
      format('%s is not executable by anon', fn)
    );
  end loop;
end;
$$;
