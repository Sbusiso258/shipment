-- 0014_board_state.sql — the board's operands.
--
-- WHAT THIS FIXES, and it is a correctness bug rather than a slow query.
--
-- The oversight board asks the database "does this shipment have ANY
-- unconfirmed checkpoint whose planned_at has passed?" and calls the answer
-- `nextExpectedOverdue`. `nextExpected()` in src/lib/journey.ts answers a
-- DIFFERENT question: the lowest unconfirmed stage ABOVE the current position.
-- Its own comment says why they differ — "a depot scan that never happened
-- while the truck is already in Durban is skipped, not next."
--
-- So a shipment whose seq-100 depot scan was never logged, while seq-200 is
-- confirmed, reads `at_risk` on the board and `on_track` on its own page.
-- That is the thing src/lib/verdicts.ts was written to stop, and
-- `verdictFor`'s own docstring claims it cannot happen: "Both call this, so
-- the board and the detail page can never disagree." It is a FALSE ALARM,
-- which non-negotiable 11 prices as the expensive kind.
--
-- The cause is that the board cannot afford to load every checkpoint of every
-- shipment, so it re-derived a cheaper rule and the cheaper rule is wrong.
-- The fix is to store the operand the real rule needs.
--
-- TWO COLUMNS, NO JUDGEMENTS. `exception_checkpoint_count` is a count of rows.
-- `next_planned_at` is a timestamp copied from one row. Neither reads the
-- clock, neither knows a timezone, neither carries a threshold.
-- src/lib/journey.ts still decides late, at risk, silent and the verdict.
-- The database counts; the library judges — non-negotiable 13.
--
-- The rule for the next column somebody wants to add here:
--
--   The database may store a value that would be UNCHANGED if the clock
--   stopped and every organisation's timezone and thresholds were different.
--   SQL materialises OPERANDS. journey.ts performs COMPARISONS.
--
-- By that test "has an overdue stage" is inadmissible — it changes at midnight
-- with no write to any table — while "the planned time of the next expected
-- stage" is fine.
--
-- NOT A VIEW. `location_points` (0002) is the view precedent and it only
-- coalesces, row-wise, over an immutable gazetteer. This needs an aggregate
-- over a child table, which in this schema is what triggers are for —
-- `checkpoints_touch_shipment` already maintains three such aggregates, so
-- two more joining them is the smallest possible change and adds NO new read
-- path, which is what keeps 0008's narrowing intact. A view would also defeat
-- the point: one containing a correlated aggregate cannot be indexed, so
-- `order by … limit` over it cannot stop early, and pagination is what the
-- board came for.
--
-- `next_planned_at` DUPLICATES nextExpected()'s rule in SQL, and that is a
-- drift risk taken knowingly — an operand cannot be computed anywhere else.
-- The mitigation is that verify-behaviour-10-board-state.sql asserts this SQL
-- against the same fixture shapes journey.test.ts asserts nextExpected
-- against, so the fixtures are the shared contract rather than this comment.

alter table public.shipments
  add column if not exists exception_checkpoint_count smallint not null default 0,
  add column if not exists next_planned_at timestamptz;

comment on column public.shipments.exception_checkpoint_count is
  'Trigger-maintained. Checkpoints carrying an exception_kind. A COUNT, not a '
  'verdict: src/lib/journey.ts decides what it means.';

comment on column public.shipments.next_planned_at is
  'Trigger-maintained. planned_at of the stage nextExpected() names — the '
  'LOWEST unconfirmed sequence above the current position, not min(planned_at) '
  'over all pending stages. An operand; the library compares it to now().';


-- ===========================================================================
-- The aggregate
-- ===========================================================================
-- Replaces the 0004 version, adding two columns to the same single pass.
--
-- NOTE THE SHAPE, because the obvious rewrite is wrong. There is no `group by`
-- and no CTE grouped by shipment: an aggregate over zero rows returns ONE row
-- (count 0, max null), whereas a grouped query over zero rows returns NONE —
-- so a grouped version would stop matching once the last checkpoint of a
-- shipment was deleted, leaving the counts frozen at their old values. The
-- flat aggregate below keeps 0004's behaviour exactly.

create or replace function public.checkpoints_touch_shipment()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target uuid := coalesce(new.shipment_id, old.shipment_id);
  floor_seq integer;
begin
  -- THE CURRENT POSITION, exactly as currentPosition() defines it: the
  -- confirmed checkpoint with the LATEST actual_at, ties breaking on the
  -- HIGHER sequence. Deliberately NOT max(sequence_no) where actual_at is not
  -- null — two scans logged out of order make those different answers, and
  -- the library's answer is the one the journey page shows.
  --
  -- 0 is a safe floor because `sequence_no > 0` is a check constraint, so it
  -- means "nothing confirmed yet" — the library's -Infinity.
  select coalesce(
    (select c.sequence_no
       from public.checkpoints c
      where c.shipment_id = target
        and c.actual_at is not null
      order by c.actual_at desc, c.sequence_no desc
      limit 1),
    0
  ) into floor_seq;

  update public.shipments s
  set last_event_at              = sub.last_event_at,
      checkpoint_count           = sub.total,
      cleared_checkpoint_count   = sub.cleared,
      exception_checkpoint_count = sub.exceptions,
      next_planned_at            = sub.next_planned_at
  from (
    select
      max(c.actual_at)                                      as last_event_at,
      count(*)                                              as total,
      count(*) filter (where c.actual_at is not null)        as cleared,
      count(*) filter (where c.exception_kind is not null)   as exceptions,
      -- THE LOWEST UNCONFIRMED SEQUENCE ABOVE THE FLOOR, and its planned
      -- time. NOT min(planned_at) over the pending set: if seq 300 were
      -- planned earlier than seq 200, min() would name seq 300 while
      -- nextExpected() names seq 200. A sequence-ordered subquery is the only
      -- formulation that matches the library.
      --
      -- It is never null when such a stage exists: `checkpoints_is_an_event`
      -- requires planned_at or actual_at, so an unconfirmed stage has a
      -- planned time by construction.
      (select c2.planned_at
         from public.checkpoints c2
        where c2.shipment_id = target
          and c2.actual_at is null
          and c2.sequence_no > floor_seq
        order by c2.sequence_no asc
        limit 1)                                            as next_planned_at
    from public.checkpoints c
    where c.shipment_id = target
  ) sub
  where s.id = target;

  return null;
end;
$fn$;


-- ===========================================================================
-- The audit exclusion list
-- ===========================================================================
-- THE MOST EXPENSIVE THING A NAIVE 0014 WOULD DO. `shipments_audit` as
-- rewritten in 0013 diffs to_jsonb(old) against to_jsonb(new) and excludes
-- three trigger-maintained aggregates by name. Two NEW trigger-maintained
-- columns not added to that list means one `shipment_updated` line in
-- decision_logs per checkpoint write, forever — recreating in the opposite
-- direction the exact failure 0013 was written to fix, where the real edits
-- get buried under bookkeeping.
--
-- So the function is replaced with the list extended to five. That duplicates
-- 0013's body, which is what 0013 did to 0012's: migrations are forward-only
-- and never edited in place (non-negotiable 8).

create or replace function public.shipments_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  changes jsonb := '{}'::jsonb;
  old_row jsonb;
  new_row jsonb;
  col     text;
begin
  if tg_op = 'INSERT' then
    perform public.write_decision_log(
      new.org_id, 'shipment_created', 'shipments', new.id, new.id,
      jsonb_build_object('reference', new.reference, 'status', new.status),
      null
    );
    return new;
  end if;

  if old.dispatched_at is null and new.dispatched_at is not null then
    perform public.write_decision_log(
      new.org_id, 'shipment_dispatched', 'shipments', new.id, new.id,
      jsonb_build_object('dispatched_at', new.dispatched_at), null
    );
  end if;

  if old.delivered_at is null and new.delivered_at is not null then
    perform public.write_decision_log(
      new.org_id, 'shipment_delivered', 'shipments', new.id, new.id,
      jsonb_build_object('delivered_at', new.delivered_at), null
    );
  end if;

  if old.cancelled_at is null and new.cancelled_at is not null then
    perform public.write_decision_log(
      new.org_id, 'shipment_cancelled', 'shipments', new.id, new.id,
      jsonb_build_object('cancelled_at', new.cancelled_at), null
    );
  end if;

  if old.status <> 'on_hold' and new.status = 'on_hold' then
    perform public.write_decision_log(
      new.org_id, 'shipment_held', 'shipments', new.id, new.id, null, null
    );
  elsif old.status = 'on_hold' and new.status <> 'on_hold' then
    perform public.write_decision_log(
      new.org_id, 'shipment_resumed', 'shipments', new.id, new.id, null, null
    );
  end if;

  old_row := to_jsonb(old);
  new_row := to_jsonb(new);

  for col in select jsonb_object_keys(new_row) loop
    continue when col in ('id', 'org_id', 'created_by', 'created_at');
    continue when col in ('dispatched_at', 'delivered_at', 'cancelled_at', 'status');

    -- TRIGGER-MAINTAINED AGGREGATES — five of them as of 0014. These move
    -- every time a checkpoint is recorded, which is not a decision anybody
    -- made about the shipment.
    continue when col in ('last_event_at', 'checkpoint_count',
                          'cleared_checkpoint_count',
                          'exception_checkpoint_count', 'next_planned_at');

    if old_row -> col is distinct from new_row -> col then
      changes := changes || jsonb_build_object(
        col, jsonb_build_object('from', old_row -> col, 'to', new_row -> col)
      );
    end if;
  end loop;

  if changes <> '{}'::jsonb then
    perform public.write_decision_log(
      new.org_id, 'shipment_updated', 'shipments', new.id, new.id, changes, null
    );
  end if;

  return new;
end;
$fn$;


-- ===========================================================================
-- The backfill
-- ===========================================================================
-- Two triggers off for the duration. `shipments_audit` would otherwise write
-- one `shipment_updated` line per shipment for a change nobody made — and
-- although the exclusion list above now covers both new columns, the backfill
-- runs in the same transaction as the function replacement and relying on
-- statement ordering for that is fragile. `shipments_set_updated_at` would
-- stamp every row as edited today, which is a visible lie on the journey page.
--
-- Both are restored below and the whole file is wrapped in a transaction by
-- bundle-migration.sh, so an abort restores them either way.
--
-- `shipments_guard_transition` (0012) is deliberately left ENABLED: this
-- touches neither status nor the lifecycle timestamps, and its row-level rule
-- sits above its auth.uid() early return (non-negotiable 9), so leaving it on
-- costs nothing and disabling a guard during a data change is a habit worth
-- not forming.
--
-- `alter table ... disable trigger` takes ACCESS EXCLUSIVE on `shipments` for
-- the transaction, so writes block for its duration. Milliseconds at current
-- volume; stated here rather than discovered.

alter table public.shipments disable trigger shipments_audit;
alter table public.shipments disable trigger shipments_set_updated_at;

update public.shipments s
set exception_checkpoint_count = sub.exceptions,
    next_planned_at            = sub.next_planned_at
from (
  select
    c.shipment_id,
    count(*) filter (where c.exception_kind is not null) as exceptions,
    (select c2.planned_at
       from public.checkpoints c2
      where c2.shipment_id = c.shipment_id
        and c2.actual_at is null
        and c2.sequence_no > coalesce((
              select c3.sequence_no
                from public.checkpoints c3
               where c3.shipment_id = c.shipment_id
                 and c3.actual_at is not null
               order by c3.actual_at desc, c3.sequence_no desc
               limit 1
            ), 0)
      order by c2.sequence_no asc
      limit 1)                                           as next_planned_at
  from public.checkpoints c
  group by c.shipment_id
) sub
where s.id = sub.shipment_id;

alter table public.shipments enable trigger shipments_set_updated_at;
alter table public.shipments enable trigger shipments_audit;


-- ===========================================================================
-- Indexes
-- ===========================================================================
-- THREE INDEXES ARE DROPPED BECAUSE NO QUERY CAN USE THEM, and 0014 is the
-- migration that admits it. Each leads with `org_id`, and the board's queries
-- carry no org filter — deliberately, per the note in src/services/shipments.ts:
-- "it would hide a broken policy during testing." The RLS predicate
-- (`is_platform_admin() or can_view_shipment(id)`) contains no org_id term
-- either, so there is nothing for the planner to grip. They have been
-- maintained on every write since 0004 and read by nothing.
--
-- `shipments_board_idx`   (org_id, status, promised_delivery_date)
-- `shipments_silence_idx` (org_id, last_event_at) where status open
-- `shipments_recent_idx`  (org_id, created_at desc)
--
-- Replaced by the same facts with the SORT KEY LEADING, which is what makes
-- `order by … limit` stop early.
--
-- Plain `drop index`, not `concurrently`: bundle-migration.sh wraps this file
-- in a transaction and refuses `concurrently` outright, because a bundle that
-- fails halfway through a live database is what that script exists to prevent.

drop index if exists public.shipments_board_idx;
drop index if exists public.shipments_silence_idx;
drop index if exists public.shipments_recent_idx;

-- The board's open set, ordered by the promise soonest at stake.
--
-- `id` is the tiebreak and it is load-bearing: promised_delivery_date is not
-- unique, and OFFSET/LIMIT over a non-unique sort key silently drops and
-- duplicates rows across pages.
create index if not exists shipments_open_promise_idx
  on public.shipments (promised_delivery_date, id)
  where status in ('planned', 'in_transit', 'on_hold');

-- /shipments, newest first, paginated. Already descending, so the scan needs
-- no reversal.
create index if not exists shipments_recent_page_idx
  on public.shipments (created_at desc, id desc);
