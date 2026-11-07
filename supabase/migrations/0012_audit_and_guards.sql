-- 0012_audit_and_guards.sql — who did what, and what may not be done.
--
-- Three things, all of which belong in the database rather than the app:
--
--   1. A decision log, written by TRIGGERS and not by application code.
--   2. A coverage guard: an active shipment may not lose its last operator.
--   3. A transition guard: delivery and cancellation are not casually undone.
--
-- WHY THE LOG IS WRITTEN BY TRIGGERS. An audit trail the application writes
-- is an audit trail the application can forget to write — and one a caller
-- can forge, because a server action is a public endpoint and the insert
-- would run as them. Triggers fire inside the same transaction as the change
-- they describe, so a shipment cannot be dispatched without the dispatch
-- being recorded, and the record cannot say it was somebody else.
--
-- `decision_logs` therefore has a SELECT policy and NOTHING ELSE. With RLS on
-- and no insert, update or delete policy, every write from the application is
-- denied — including from an admin. The only thing that can write is the
-- `security definer` trigger below. That is what makes the trail worth
-- having: non-negotiable #1 says authorization is a database property, and so
-- is integrity.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- decision_logs
-- ===========================================================================

create type public.decision_action as enum (
  'shipment_created',
  'shipment_updated',
  'shipment_dispatched',
  'shipment_delivered',
  'shipment_cancelled',
  'shipment_held',
  'shipment_resumed',
  'operator_assigned',
  'operator_withdrawn',
  'party_granted',
  'party_revoked',
  'checkpoint_recorded',
  'checkpoint_confirmed',
  'exception_reported'
);

create table public.decision_logs (
  id uuid primary key default gen_random_uuid(),

  -- Denormalised tenancy, as everywhere else: a policy on this table is one
  -- lookup rather than a join through another table's policy.
  org_id uuid not null references public.organisations (id) on delete cascade,

  -- NULLABLE, deliberately. `auth.uid()` is null when a row is changed
  -- outside a user session — a migration, the SQL editor, a future batch job.
  -- "Changed by somebody unknown" is a true statement; inventing an actor
  -- would be a false one, and a false line in an audit trail is worse than a
  -- missing one.
  actor_id uuid references auth.users (id) on delete set null,

  action public.decision_action not null,

  -- What it happened to. `shipment_id` is called out separately from the
  -- generic subject because "show me this load's history" is the question
  -- this table exists to answer, and it should be an index seek.
  subject_table text not null,
  subject_id    uuid not null,
  shipment_id   uuid,

  -- Only the columns that actually changed, old and new. Not whole rows:
  -- a row carries `cargo_value` and `notes`, and an audit trail that copies
  -- every column becomes a second, unpoliced copy of the shipment.
  changed jsonb,

  -- For the corrections that need one — reopening a delivered shipment,
  -- withdrawing an operator mid-journey.
  reason text,

  created_at timestamptz not null default now()
);

-- The question this table exists to answer.
create index decision_logs_shipment_idx
  on public.decision_logs (shipment_id, created_at desc)
  where shipment_id is not null;

-- ...and the dashboard's "what happened today".
create index decision_logs_org_idx
  on public.decision_logs (org_id, created_at desc);


-- ===========================================================================
-- The writer
-- ===========================================================================
-- `security definer` so it can insert into a table nobody else may write to.
-- The five rules from 0001 apply: definer, pinned search_path, no user-id
-- parameter (it reads `auth.uid()` itself), and execute revoked.

create or replace function public.write_decision_log(
  target_org     uuid,
  target_action  public.decision_action,
  target_table   text,
  target_id      uuid,
  target_shipment uuid,
  target_changed jsonb,
  target_reason  text
)
returns void
language sql
security definer
set search_path = public
as $fn$
  insert into public.decision_logs
    (org_id, actor_id, action, subject_table, subject_id, shipment_id, changed, reason)
  values
    (target_org, (select auth.uid()), target_action, target_table, target_id,
     target_shipment, target_changed, target_reason);
$fn$;

-- Nothing outside this schema calls it. Revoked from everybody: the triggers
-- below run as the function owner and do not need a grant.
revoke execute on function public.write_decision_log(
  uuid, public.decision_action, text, uuid, uuid, jsonb, text
) from public, anon, authenticated;


-- ===========================================================================
-- Shipments: what changed, and what may not change
-- ===========================================================================

create or replace function public.shipments_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform public.write_decision_log(
      new.org_id, 'shipment_created', 'shipments', new.id, new.id,
      jsonb_build_object('reference', new.reference, 'status', new.status),
      null
    );
    return new;
  end if;

  -- The lifecycle moments get their own action, because "dispatched" is the
  -- thing somebody will search for — not "updated, and among the columns was
  -- dispatched_at".
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

  -- Everything else, as a before/after of only the columns that moved.
  if old.reference is distinct from new.reference then
    changes := changes || jsonb_build_object('reference',
      jsonb_build_object('from', old.reference, 'to', new.reference));
  end if;
  if old.promised_delivery_date is distinct from new.promised_delivery_date then
    changes := changes || jsonb_build_object('promised_delivery_date',
      jsonb_build_object('from', old.promised_delivery_date,
                         'to', new.promised_delivery_date));
  end if;
  if old.origin_location_id is distinct from new.origin_location_id
     or old.destination_location_id is distinct from new.destination_location_id then
    changes := changes || jsonb_build_object('route', 'changed');
  end if;

  if changes <> '{}'::jsonb then
    perform public.write_decision_log(
      new.org_id, 'shipment_updated', 'shipments', new.id, new.id, changes, null
    );
  end if;

  return new;
end;
$fn$;

create trigger shipments_audit
  after insert or update on public.shipments
  for each row execute function public.shipments_audit();


/**
 * Delivery and cancellation are not casually undone.
 *
 * A delivered shipment IS the oversight record. Letting it drop back to
 * planned would rewrite what a customer was told, and the one thing this
 * product sells is being believed. An admin may still correct a mistake —
 * people do confirm the wrong load — but an operator may not, and the
 * correction is logged by the trigger above like everything else.
 */
create or replace function public.shipments_guard_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- A load cannot arrive somewhere it never left. The 0004 constraint
  -- `shipments_delivery_after_dispatch` short-circuits on
  -- `dispatched_at is null`, so it permits a delivery with NO dispatch at
  -- all — a stage skipped rather than a stage merely unrecorded.
  --
  -- THIS CHECK SITS ABOVE THE SESSION TEST BELOW, because it is a fact about
  -- the row and not a question about who is asking. A migration, a batch job
  -- or somebody in the SQL editor can no more deliver an undispatched load
  -- than an operator can. Putting it below the early return disabled it for
  -- every caller without a session — and for the verification suite, which
  -- is how that was caught.
  if new.delivered_at is not null and new.dispatched_at is null then
    raise exception 'A shipment cannot be delivered before it has been dispatched'
      using errcode = 'check_violation';
  end if;

  -- THE REMAINING RULES ASK WHO IS ASKING, and outside a user session there
  -- is no role to check. `auth.uid()` is null for a migration, the SQL editor
  -- or a future batch job — and somebody with a direct connection is already
  -- past every policy in this schema, so refusing them here would protect
  -- nothing. The same judgement as `tasks_stamp_completion` and
  -- `shipments_assign_creator`.
  if (select auth.uid()) is null then
    return new;
  end if;

  if old.delivered_at is not null and new.delivered_at is null
     and not public.has_org_role(old.org_id, array['admin']::public.membership_role[])
  then
    raise exception 'Only an admin can reopen a delivered shipment'
      using errcode = 'insufficient_privilege';
  end if;

  if old.cancelled_at is not null and new.cancelled_at is null
     and not public.has_org_role(old.org_id, array['admin']::public.membership_role[])
  then
    raise exception 'Only an admin can reinstate a cancelled shipment'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

create trigger shipments_guard_transition
  before update on public.shipments
  for each row execute function public.shipments_guard_transition();


-- ===========================================================================
-- Assignments: the coverage guard
-- ===========================================================================

create or replace function public.shipment_assignments_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.write_decision_log(
      new.org_id, 'operator_assigned', 'shipment_assignments', new.id,
      new.shipment_id, jsonb_build_object('user_id', new.user_id), new.note
    );
  elsif old.unassigned_at is null and new.unassigned_at is not null then
    perform public.write_decision_log(
      new.org_id, 'operator_withdrawn', 'shipment_assignments', new.id,
      new.shipment_id, jsonb_build_object('user_id', new.user_id), new.note
    );
  end if;

  return new;
end;
$fn$;

create trigger shipment_assignments_audit
  after insert or update on public.shipment_assignments
  for each row execute function public.shipment_assignments_audit();


/**
 * THE COVERAGE GUARD.
 *
 * A shipment that is moving must not be left with nobody responsible for it.
 * Withdrawing the last operator from an active load is how a shipment goes
 * quiet for three days and nobody notices — which is the exact failure this
 * product exists to prevent.
 *
 * It applies only while the load is ACTIVE. A delivered or cancelled
 * shipment has nothing left to cover, and forcing somebody to stay assigned
 * to finished work would make the list useless.
 *
 * It also does not fire during the shipment's own deletion: the same lesson
 * as 0010, where a guard on a child table refused every parent delete because
 * it could not tell that the parent was going too.
 */
create or replace function public.shipment_assignments_guard_coverage()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  remaining integer;
  shipment  record;
begin
  -- Only a withdrawal can empty the set.
  if old.unassigned_at is not null or new.unassigned_at is null then
    return new;
  end if;

  select s.delivered_at, s.cancelled_at into shipment
  from public.shipments s
  where s.id = old.shipment_id;

  -- The shipment is going with it. See 0010.
  if not found then
    return new;
  end if;

  if shipment.delivered_at is not null or shipment.cancelled_at is not null then
    return new;
  end if;

  select count(*) into remaining
  from public.shipment_assignments a
  where a.shipment_id = old.shipment_id
    and a.unassigned_at is null
    and a.id <> old.id;

  if remaining = 0 then
    raise exception
      'This load would be left with nobody on it. Assign somebody else first.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger shipment_assignments_guard_coverage
  before update on public.shipment_assignments
  for each row execute function public.shipment_assignments_guard_coverage();


-- ===========================================================================
-- Party grants, checkpoints
-- ===========================================================================

create or replace function public.shipment_parties_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.write_decision_log(
      new.org_id, 'party_granted', 'shipment_parties', new.id, new.shipment_id,
      jsonb_build_object('party_org_id', new.party_org_id,
                         'party_role', new.party_role), null
    );
  elsif old.revoked_at is null and new.revoked_at is not null then
    perform public.write_decision_log(
      new.org_id, 'party_revoked', 'shipment_parties', new.id, new.shipment_id,
      jsonb_build_object('party_org_id', new.party_org_id), null
    );
  end if;

  return new;
end;
$fn$;

create trigger shipment_parties_audit
  after insert or update on public.shipment_parties
  for each row execute function public.shipment_parties_audit();


create or replace function public.checkpoints_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.write_decision_log(
      new.org_id,
      case when new.exception_kind is not null
           then 'exception_reported'::public.decision_action
           else 'checkpoint_recorded'::public.decision_action end,
      'checkpoints', new.id, new.shipment_id,
      jsonb_build_object('label', new.label, 'kind', new.kind,
                         'exception_kind', new.exception_kind),
      new.note
    );
  elsif old.actual_at is null and new.actual_at is not null then
    perform public.write_decision_log(
      new.org_id, 'checkpoint_confirmed', 'checkpoints', new.id, new.shipment_id,
      jsonb_build_object('label', new.label, 'actual_at', new.actual_at), new.note
    );
  end if;

  return new;
end;
$fn$;

create trigger checkpoints_audit
  after insert or update on public.checkpoints
  for each row execute function public.checkpoints_audit();


-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- SELECT AND NOTHING ELSE. No insert, update or delete policy means every
-- such write from the application is refused — the triggers above are the
-- only writer, and they run as the function owner. An audit trail that its
-- own users can edit is a diary, not a record.

alter table public.decision_logs enable row level security;

-- Internal history. NOT widened to party organisations: a consignee may watch
-- a load, but who inside the carrier made which decision is the carrier's
-- business. The platform owner is out too, for the same reason they are
-- locked out of `messages` in 0007.
create policy decision_logs_select_member on public.decision_logs
  for select to authenticated using (
    public.is_org_member(org_id)
    and (
      shipment_id is null
      or public.can_view_shipment(shipment_id)
    )
  );

comment on table public.decision_logs is
  'Append-only operational history. Written only by security-definer triggers '
  'inside the transaction that made the change; there is deliberately no '
  'insert, update or delete policy, so it cannot be forged or edited.';
