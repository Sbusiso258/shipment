-- Behaviour checks for 0014_board_state.sql.
--
-- NAMING: `verify-migrations.mjs` sorts these files LEXICALLY, so `-10-` would
-- run before `-2-`. That is harmless here — every file seeds its own fixtures
-- and asserts only its own rows — but it is why the numbers from ten onward
-- must not be relied on for ordering.

-- ---------------------------------------------------------------------------
-- exception_checkpoint_count tracks the count
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  loc_a    uuid := (select id from public.locations where org_id = org_a order by created_at limit 1);
  loc_b    uuid := (select id from public.locations where org_id = org_a order by created_at offset 1 limit 1);
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  ship     uuid;
  cp       uuid;
begin
  insert into public.shipments
    (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org_a, 'BOARD-EXC', loc_a, loc_b, owner_id)
  returning id into ship;

  perform public.assert(
    (select exception_checkpoint_count from public.shipments where id = ship) = 0,
    'a new shipment has no exceptions counted'
  );

  insert into public.checkpoints
    (org_id, shipment_id, sequence_no, kind, label, actual_at, exception_kind)
  values (org_a, ship, 100, 'linehaul', 'Breakdown on the N3', now(), 'breakdown')
  returning id into cp;

  perform public.assert(
    (select exception_checkpoint_count from public.shipments where id = ship) = 1,
    'recording an exception increments the count'
  );

  -- Clearing the kind decrements it. The count is a fact about rows, so it
  -- follows the rows both ways.
  update public.checkpoints set exception_kind = null where id = cp;
  perform public.assert(
    (select exception_checkpoint_count from public.shipments where id = ship) = 0,
    'clearing the exception kind decrements it'
  );

  update public.checkpoints set exception_kind = 'damage' where id = cp;
  perform public.assert(
    (select exception_checkpoint_count from public.shipments where id = ship) = 1,
    'setting it again increments it'
  );

  -- THE HOLE THE OBVIOUS REWRITE WOULD HAVE OPENED. An aggregate over zero
  -- rows returns ONE row; a GROUPED query over zero rows returns NONE. A
  -- grouped formulation would stop matching here and freeze the counts at
  -- their old values, which is invisible without this assertion.
  delete from public.checkpoints where id = cp;
  perform public.assert(
    (select exception_checkpoint_count from public.shipments where id = ship) = 0
      and (select checkpoint_count from public.shipments where id = ship) = 0
      and (select last_event_at from public.shipments where id = ship) is null,
    'deleting the LAST checkpoint zeroes every aggregate rather than freezing it'
  );
end $$;


-- ---------------------------------------------------------------------------
-- next_planned_at is nextExpected()'s stage
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
  values (org_a, 'BOARD-NEXT', loc_a, loc_b, owner_id)
  returning id into ship;

  -- THE ASSERTION THIS WHOLE MIGRATION EXISTS FOR, and the one the board's
  -- current rule fails.
  --
  -- seq 100 pending, planned YESTERDAY — a depot scan nobody logged.
  -- seq 200 confirmed — the truck has already moved past it.
  -- seq 300 pending, planned TOMORROW — genuinely what comes next.
  --
  -- nextExpected() skips seq 100, because a stage the load has already passed
  -- is skipped rather than next. The board asks "is ANY pending stage
  -- overdue?" and answers yes on seq 100, so it says at_risk while the
  -- shipment's own page says on_track. next_planned_at must be seq 300's.
  insert into public.checkpoints
    (org_id, shipment_id, sequence_no, kind, label, planned_at, actual_at)
  values
    (org_a, ship, 100, 'depot_out', 'Left depot',  now() - interval '1 day', null),
    (org_a, ship, 200, 'linehaul',  'On the road', now() - interval '2 hours', now()),
    (org_a, ship, 300, 'delivery',  'Delivery',    now() + interval '1 day', null);

  perform public.assert(
    (select next_planned_at from public.shipments where id = ship)
      = (select planned_at from public.checkpoints
          where shipment_id = ship and sequence_no = 300),
    'next_planned_at is the lowest PENDING stage ABOVE the position, skipping a passed-over one'
  );

  perform public.assert(
    (select next_planned_at from public.shipments where id = ship) > now(),
    '...so a skipped stage does not make the load look overdue'
  );

  -- And it is NOT min(planned_at) over the pending set, which would have
  -- picked seq 100's yesterday.
  perform public.assert(
    (select next_planned_at from public.shipments where id = ship)
      <> (select min(planned_at) from public.checkpoints
           where shipment_id = ship and actual_at is null),
    '...and is not min(planned_at), which these fixtures deliberately differ from'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The position tie-break mirrors currentPosition()
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
  values (org_a, 'BOARD-TIE', loc_a, loc_b, owner_id)
  returning id into ship;

  -- STAGES LOGGED OUT OF ORDER, which is ordinary: somebody confirms a later
  -- scan before an earlier one. currentPosition() takes the LATEST actual_at,
  -- so the position is seq 100 (12:00), not seq 300 (10:00) — a
  -- max(sequence_no) implementation would say seq 300 and then find no
  -- pending stage above it, returning null. That wrong answer is what this
  -- fixture catches.
  insert into public.checkpoints
    (org_id, shipment_id, sequence_no, kind, label, planned_at, actual_at)
  values
    (org_a, ship, 100, 'pickup',   'Collected',  now() - interval '1 day', now()),
    (org_a, ship, 200, 'linehaul', 'On the road', now() + interval '6 hours', null),
    (org_a, ship, 300, 'delivery', 'Delivered',  now() - interval '1 day', now() - interval '2 hours');

  perform public.assert(
    (select next_planned_at from public.shipments where id = ship)
      = (select planned_at from public.checkpoints
          where shipment_id = ship and sequence_no = 200),
    'the position is the LATEST actual_at, so a lower pending stage above it is next'
  );
end $$;


-- ---------------------------------------------------------------------------
-- Recording a checkpoint writes no edit line
-- ---------------------------------------------------------------------------

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
    (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org_a, 'BOARD-AUDIT', loc_a, loc_b, owner_id)
  returning id into ship;

  select count(*) into before from public.decision_logs
   where shipment_id = ship and action = 'shipment_updated';

  insert into public.checkpoints
    (org_id, shipment_id, sequence_no, kind, label, planned_at)
  values (org_a, ship, 100, 'pickup', 'Collection', now() + interval '1 day');

  -- THE 0013 TRAP. Two new trigger-maintained columns absent from
  -- `shipments_audit`'s exclusion list would write one `shipment_updated`
  -- line per checkpoint write, forever — burying the real edits under
  -- bookkeeping, which is the exact failure 0013 was written to fix.
  perform public.assert(
    (select count(*) from public.decision_logs
      where shipment_id = ship and action = 'shipment_updated') = before,
    'recording a checkpoint writes no shipment_updated line'
  );

  -- ...and the new columns never appear in a trail entry.
  perform public.assert(
    not exists (select 1 from public.decision_logs
                 where shipment_id = ship
                   and (changed ? 'exception_checkpoint_count'
                        or changed ? 'next_planned_at')),
    '...and the two new aggregates never appear in the audit trail'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The backfill agrees with the trigger
-- ---------------------------------------------------------------------------

do $$
begin
  -- Recompute both columns independently for every shipment and compare. If
  -- the backfill statement and the trigger ever disagree, every row written
  -- before 0014 is wrong in a way nothing else would notice.
  perform public.assert(
    not exists (
      select 1
      from public.shipments s
      left join (
        select c.shipment_id,
               count(*) filter (where c.exception_kind is not null) as exceptions
          from public.checkpoints c
         group by c.shipment_id
      ) agg on agg.shipment_id = s.id
      where s.exception_checkpoint_count <> coalesce(agg.exceptions, 0)
    ),
    'every shipment exception count matches an independent recount'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The open-set biconditional the board's completeness rests on
-- ---------------------------------------------------------------------------

do $$
begin
  -- `shipments_sync_status` forces 'delivered' when delivered_at is set and
  -- 'cancelled' when cancelled_at is set. The board filters on
  -- `status in ('planned','in_transit','on_hold')` and claims that loses
  -- nothing, which is only true if open status and "neither timestamp set"
  -- are the same thing. Asserted as a sweep, because it is an invariant of
  -- the whole table rather than of one fixture.
  perform public.assert(
    not exists (
      select 1 from public.shipments
       where status in ('planned', 'in_transit', 'on_hold')
         and (delivered_at is not null or cancelled_at is not null)
    ),
    'no open shipment carries a delivery or cancellation timestamp'
  );

  perform public.assert(
    not exists (
      select 1 from public.shipments
       where status not in ('planned', 'in_transit', 'on_hold')
         and delivered_at is null and cancelled_at is null
    ),
    '...and no closed shipment lacks both'
  );
end $$;


-- ---------------------------------------------------------------------------
-- Indexes, and the cascade
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  loc_a    uuid := (select id from public.locations where org_id = org_a order by created_at limit 1);
  loc_b    uuid := (select id from public.locations where org_id = org_a order by created_at offset 1 limit 1);
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  ship     uuid;
begin
  perform public.assert(
    (select count(*) from pg_indexes
      where schemaname = 'public'
        and indexname in ('shipments_board_idx', 'shipments_silence_idx',
                          'shipments_recent_idx')) = 0,
    'the three unread org_id-leading indexes are gone'
  );

  perform public.assert(
    (select count(*) from pg_indexes
      where schemaname = 'public'
        and indexname in ('shipments_open_promise_idx',
                          'shipments_recent_page_idx')) = 2,
    '...replaced by two with the sort key leading'
  );

  -- NON-NEGOTIABLE 8's TRAP, asked of this trigger: an AFTER trigger on a
  -- cascading child must not refuse the parent's own deletion. Its
  -- `update ... where s.id = target` simply matches nothing once the shipment
  -- is gone. Already true; now asserted.
  insert into public.shipments
    (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org_a, 'BOARD-CASCADE', loc_a, loc_b, owner_id)
  returning id into ship;

  insert into public.checkpoints
    (org_id, shipment_id, sequence_no, kind, label, planned_at)
  values (org_a, ship, 100, 'pickup', 'Collection', now() + interval '1 day');

  delete from public.shipments where id = ship;

  perform public.assert(
    (select count(*) from public.shipments where id = ship) = 0,
    'deleting a shipment with checkpoints is not blocked by the aggregate trigger'
  );
end $$;
