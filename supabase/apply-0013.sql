-- apply-0013.sql — 1 migration(s), as one transaction.
--
-- GENERATED. Do not edit: edit the migrations and regenerate with
--   bash supabase/bundle-migration.sh 0013
--
-- Paste the WHOLE file into the Supabase SQL editor and run it once.
-- It either all applies or none of it does.
--
-- Make sure nothing is selected in the editor first: it runs the
-- SELECTION when there is one, and half a statement fails.
--
-- The last statement reports what landed. If no row comes back,
-- it did not run.

begin;


-- ============================================================
-- 0013_audit_every_column.sql
-- ============================================================
-- 0013_audit_every_column.sql
--
-- THE TRAIL WAS WATCHING THREE COLUMNS.
--
-- `shipments_audit` in 0012 compared `reference`, `promised_delivery_date` and
-- the two endpoints, and nothing else. So an edit to the cargo value, the
-- weight, the carrier, the driver, the vehicle, the goods description, the
-- planned dispatch or delivery time, the silence threshold or the notes
-- changed the shipment and left NO LINE AT ALL. The table, the writer and the
-- trigger were all correct; they simply did not look at most of the row.
--
-- Found by editing a shipment in the live app and watching the history panel
-- stay empty. `verify-behaviour-8-audit.sql` did not catch it because its edit
-- changed `reference` — one of the three columns that happened to be watched.
-- A test that proves the mechanism is not a test that proves the coverage.
--
-- The fix is to stop enumerating. This version diffs `to_jsonb(old)` against
-- `to_jsonb(new)` and records every key that moved, with an explicit list of
-- exclusions. A column added by a future migration is then audited the day it
-- exists, rather than the day somebody remembers to add it here — which is
-- the failure mode that produced this migration.

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

  -- The lifecycle moments keep their own actions, because "dispatched" is the
  -- thing somebody will search for — not "updated, and among the columns was
  -- dispatched_at". These columns are therefore excluded from the diff below:
  -- reporting them twice would put two lines in the trail for one event.
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

  -- EVERYTHING ELSE THAT MOVED, old and new, whatever it is.
  old_row := to_jsonb(old);
  new_row := to_jsonb(new);

  for col in select jsonb_object_keys(new_row) loop
    -- Identity: cannot change, or is guarded elsewhere if it tries.
    continue when col in ('id', 'org_id', 'created_by', 'created_at');

    -- Already reported above, as their own actions.
    continue when col in ('dispatched_at', 'delivered_at', 'cancelled_at', 'status');

    -- TRIGGER-MAINTAINED AGGREGATES. These move every time a checkpoint is
    -- recorded, which is not a decision anybody made about the shipment.
    -- Auditing them would bury the real edits under bookkeeping and make the
    -- panel useless for the one question it exists to answer.
    continue when col in ('last_event_at', 'checkpoint_count',
                          'cleared_checkpoint_count');

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
-- Ordering within a transaction
-- ===========================================================================
-- `created_at` defaulted to `now()`, which is the TRANSACTION's start time —
-- identical for every row written by one statement or one block. Several
-- lines are routinely written together (an edit that also dispatches; a
-- future batch), and they all carried the same stamp, so
-- `order by created_at desc` put them in an arbitrary order and the history
-- panel could show an effect above its cause.
--
-- `clock_timestamp()` is the actual wall clock, read per call, so lines
-- written in one transaction order correctly against each other. For an
-- append-only trail that ordering IS the content.
--
-- Existing rows keep the stamps they were written with: a default change is
-- not retroactive, and rewriting them would be falsifying the trail to make
-- it tidier.
alter table public.decision_logs
  alter column created_at set default clock_timestamp();

comment on column public.decision_logs.created_at is
  'clock_timestamp(), not now(): lines written in one transaction must order '
  'against each other, and now() is the transaction start for all of them.';


-- The trigger itself is unchanged and still points at this function; 0012
-- created it. Replacing the function is the whole migration.

comment on function public.shipments_audit() is
  'Audits every column of shipments except identity, the lifecycle timestamps '
  'reported as their own actions, and the trigger-maintained aggregates. '
  'Diffs to_jsonb(old) against to_jsonb(new) rather than naming columns, so a '
  'column added by a later migration is audited without being added here.';

commit;


-- ============================================================
-- Did it work? This row is the answer.
-- ============================================================
-- EVERY MIGRATION IN THE RANGE GETS A COLUMN. This report used to stop at
-- 0009 while the bundle carried five migrations, so a paste that applied
-- part of the range would still return a reassuring row. A null in any
-- column below means that migration did not land.
select
  current_database()                             as database,
  to_regclass('public.shipment_assignments')     as table_0008,
  to_regproc('public.is_assigned_to_shipment')   as function_0008,
  to_regproc('public.find_organisation_by_slug') as function_0009,
  to_regclass('public.drivers')                  as table_0011,
  to_regclass('public.vehicles')                 as table_0011b,
  to_regclass('public.decision_logs')            as table_0012,
  to_regproc('public.write_decision_log')        as function_0012,

  -- 0010 left no new object behind, so it is reported by the behaviour it
  -- fixed: the guard now checks whether the parent organisation still
  -- exists before refusing a cascading delete.
  (select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'memberships_guard_last_admin'
     and p.prosrc like '%from public.organisations%')
                                                 as must_be_one_0010,

  -- 0008's narrowing is only real once this branch is gone from every
  -- shipment-data policy. Anything other than zero means an operator can
  -- still see loads they are not on.
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('shipments', 'checkpoints')
      and cmd = 'SELECT'
      and qual like '%is_org_member%')           as must_be_zero,

  -- 0012's whole point: one policy on the trail, and it reads.
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'decision_logs'
      and cmd <> 'SELECT')                       as must_be_zero_0012;
