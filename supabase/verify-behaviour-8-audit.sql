-- Behaviour checks for 0012_audit_and_guards.sql.
--
-- Three rules the application is deliberately not trusted with: the audit
-- trail writes itself, an active load keeps an operator, and a delivery is
-- not casually undone.

-- ---------------------------------------------------------------------------
-- The trail writes itself
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  loc_a    uuid := (select id from public.locations where org_id = org_a order by created_at limit 1);
  loc_b    uuid := (select id from public.locations where org_id = org_a order by created_at offset 1 limit 1);
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  ship     uuid;
  edit     jsonb;
begin
  insert into public.shipments
    (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org_a, 'AUDIT-001', loc_a, loc_b, owner_id)
  returning id into ship;

  perform public.assert(
    (select count(*) from public.decision_logs
      where shipment_id = ship and action = 'shipment_created') = 1,
    'creating a shipment writes its own log line'
  );

  -- Each lifecycle moment gets its own action, because "dispatched" is what
  -- somebody searches for — not "updated, and among the columns was
  -- dispatched_at".
  update public.shipments set dispatched_at = now() where id = ship;
  perform public.assert(
    (select count(*) from public.decision_logs
      where shipment_id = ship and action = 'shipment_dispatched') = 1,
    'dispatching writes its own action, not a generic update'
  );

  update public.shipments set delivered_at = now() where id = ship;
  perform public.assert(
    (select count(*) from public.decision_logs
      where shipment_id = ship and action = 'shipment_delivered') = 1,
    'delivery writes its own action'
  );

  -- An ordinary edit records WHAT MOVED, old and new.
  update public.shipments set reference = 'AUDIT-001-B' where id = ship;

  select changed into edit from public.decision_logs
   where shipment_id = ship and action = 'shipment_updated'
   order by created_at desc limit 1;

  perform public.assert(
    edit -> 'reference' ->> 'from' = 'AUDIT-001',
    'an edit records the value it replaced'
  );

  -- Not the whole row. A trail that copies every column is a second,
  -- unpoliced copy of the shipment — including its cargo value.
  perform public.assert(
    not (edit ? 'cargo_value'),
    '...and only the columns that moved, never the whole row'
  );

  -- Outside a user session there is nobody to name, and naming one would put
  -- a false line in an audit trail.
  perform public.assert(
    (select actor_id is null from public.decision_logs
      where shipment_id = ship order by created_at limit 1),
    'a change made outside a session records no actor rather than inventing one'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The trail watches the WHOLE row
-- ---------------------------------------------------------------------------
--
-- 0012 compared three columns and nothing else, so editing the cargo value or
-- the notes left no line at all. The block above did not catch it because its
-- edit changed `reference`, which happened to be one of the three. These
-- checks are deliberately about columns the first version IGNORED.

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  loc_a    uuid := (select id from public.locations where org_id = org_a order by created_at limit 1);
  loc_b    uuid := (select id from public.locations where org_id = org_a order by created_at offset 1 limit 1);
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  ship     uuid;
  before   integer;
begin
  insert into public.shipments
    (org_id, reference, origin_location_id, destination_location_id, created_by,
     cargo_value, weight_kg, notes)
  values (org_a, 'COVERAGE-001', loc_a, loc_b, owner_id, 1000, 500, 'first')
  returning id into ship;

  -- Each of these was silently unaudited.
  -- EVERY ASSERTION BELOW LOOKS FOR ITS OWN LINE BY CONTENT. Inside a single
  -- `do` block every statement shares one transaction, and `now()` is the
  -- transaction's start, so all these lines carry the SAME `created_at` and
  -- "order by created_at desc limit 1" picks an arbitrary one. That is what
  -- made the first draft of this block fail against a working trigger.
  update public.shipments set notes = 'second' where id = ship;
  perform public.assert(
    exists (select 1 from public.decision_logs
             where shipment_id = ship and action = 'shipment_updated'
               and changed -> 'notes' ->> 'from' = 'first'),
    'editing the NOTES writes a line'
  );

  update public.shipments set cargo_value = 2000 where id = ship;
  perform public.assert(
    exists (select 1 from public.decision_logs
             where shipment_id = ship and action = 'shipment_updated'
               and (changed -> 'cargo_value' ->> 'to')::numeric = 2000),
    'editing the CARGO VALUE writes a line'
  );

  update public.shipments set weight_kg = 750 where id = ship;
  perform public.assert(
    exists (select 1 from public.decision_logs
             where shipment_id = ship and action = 'shipment_updated'
               and changed ? 'weight_kg'),
    'editing the WEIGHT writes a line'
  );

  update public.shipments set planned_delivery_at = now() where id = ship;
  perform public.assert(
    exists (select 1 from public.decision_logs
             where shipment_id = ship and action = 'shipment_updated'
               and changed ? 'planned_delivery_at'),
    'editing a PLANNED TIME writes a line'
  );

  -- A column the diff must keep ignoring. The checkpoint counters move on
  -- every stage recorded, and auditing them would bury the real edits.
  select count(*) into before from public.decision_logs
   where shipment_id = ship and action = 'shipment_updated';

  insert into public.checkpoints
    (org_id, shipment_id, sequence_no, kind, label, actual_at)
  values (org_a, ship, 10, 'hub_scan', 'Counter mover', now());

  perform public.assert(
    (select count(*) from public.decision_logs
      where shipment_id = ship and action = 'shipment_updated') = before,
    'the trigger-maintained counters do NOT write edit lines'
  );

  -- ...and the identity columns are never reported as having moved.
  update public.shipments set reference = 'COVERAGE-002' where id = ship;
  perform public.assert(
    not exists (select 1 from public.decision_logs
                 where shipment_id = ship
                   and (changed ? 'id' or changed ? 'org_id'
                        or changed ? 'created_at' or changed ? 'created_by')),
    'identity columns stay out of the trail'
  );

  -- ONE EVENT, ONE LINE. The lifecycle columns are reported as their own
  -- actions, so the generic diff must not report them a second time.
  update public.shipments set dispatched_at = now() where id = ship;
  perform public.assert(
    (select count(*) from public.decision_logs
      where shipment_id = ship and action = 'shipment_dispatched') = 1,
    'dispatch still writes exactly one line of its own'
  );
  perform public.assert(
    not exists (select 1 from public.decision_logs
                 where shipment_id = ship and action = 'shipment_updated'
                   and (changed ? 'dispatched_at' or changed ? 'status')),
    '...and is not also reported as a generic edit'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The trail cannot be edited
-- ---------------------------------------------------------------------------

do $$
begin
  -- SELECT and nothing else. Every write from the application is refused,
  -- including from an admin: the triggers are the only writer.
  perform public.assert(
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'decision_logs') = 1,
    'decision_logs has exactly one policy'
  );
  perform public.assert(
    (select cmd from pg_policies
      where schemaname = 'public' and tablename = 'decision_logs') = 'SELECT',
    '...and it is SELECT — the trail cannot be written, edited or deleted'
  );

  -- The writer bypasses RLS, so it obeys the five rules from 0001.
  perform public.assert(
    (select p.prosecdef from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'write_decision_log'),
    'write_decision_log is security definer'
  );
  perform public.assert(
    (select p.proconfig @> array['search_path=public'] from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'write_decision_log'),
    'write_decision_log pins its search_path'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The coverage guard
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  loc_a    uuid := (select id from public.locations where org_id = org_a order by created_at limit 1);
  loc_b    uuid := (select id from public.locations where org_id = org_a order by created_at offset 1 limit 1);
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  admin_id uuid := '22222222-2222-2222-2222-222222222222';
  oper_id  uuid := '33333333-3333-3333-3333-333333333333';
  ship     uuid;
  only_one uuid;
  second   uuid;
begin
  insert into public.shipments
    (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org_a, 'COVER-001', loc_a, loc_b, owner_id)
  returning id into ship;

  insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
  values (org_a, ship, oper_id, admin_id)
  returning id into only_one;

  -- THE RULE. Withdrawing the last operator from a live load is how a
  -- shipment goes quiet for three days and nobody notices, which is the
  -- exact failure this product exists to prevent.
  perform public.assert_rejects(
    format('update public.shipment_assignments set unassigned_at = now() where id = %L',
           only_one),
    'the last operator cannot be withdrawn from an active shipment'
  );

  perform public.assert(
    (select unassigned_at is null from public.shipment_assignments where id = only_one),
    '...and the assignment is left alone'
  );

  -- With somebody else on it, the withdrawal is ordinary.
  insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
  values (org_a, ship, admin_id, admin_id)
  returning id into second;

  update public.shipment_assignments set unassigned_at = now() where id = only_one;

  perform public.assert(
    (select unassigned_at is not null from public.shipment_assignments where id = only_one),
    'an operator CAN be withdrawn once somebody else is on the load'
  );

  -- A finished load has nothing left to cover, and forcing somebody to stay
  -- assigned to completed work would make the list useless.
  update public.shipments set dispatched_at = now(), delivered_at = now() where id = ship;
  update public.shipment_assignments set unassigned_at = now() where id = second;

  perform public.assert(
    (select count(*) from public.shipment_assignments
      where shipment_id = ship and unassigned_at is null) = 0,
    'a delivered shipment may be left with nobody on it'
  );

  -- And the guard must not block the shipment's own deletion — the lesson
  -- 0010 had to learn about guards on cascading children.
  delete from public.shipments where id = ship;
  perform public.assert(
    (select count(*) from public.shipments where id = ship) = 0,
    'the coverage guard does not block deleting the shipment itself'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The transition guard
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  loc_a    uuid := (select id from public.locations where org_id = org_a order by created_at limit 1);
  loc_b    uuid := (select id from public.locations where org_id = org_a order by created_at offset 1 limit 1);
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  ship     uuid;
begin
  insert into public.shipments
    (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org_a, 'STAGE-001', loc_a, loc_b, owner_id)
  returning id into ship;

  -- A load cannot arrive somewhere it never left. The existing
  -- `shipments_delivery_after_dispatch` constraint permits a delivery with no
  -- dispatch at all; this closes it, because a delivery with no departure is
  -- a stage SKIPPED rather than a stage merely unrecorded.
  perform public.assert_rejects(
    format('update public.shipments set delivered_at = now() where id = %L', ship),
    'a shipment cannot be delivered before it has been dispatched'
  );

  update public.shipments set dispatched_at = now() where id = ship;
  update public.shipments set delivered_at = now() where id = ship;

  perform public.assert(
    (select status from public.shipments where id = ship) = 'delivered',
    'dispatch then deliver is the ordinary path'
  );
end $$;
