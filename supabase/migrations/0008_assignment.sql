-- 0008_assignment.sql — an operator sees the shipments they are assigned to.
--
-- THIS MIGRATION TAKES ACCESS AWAY. Every other migration in this schema has
-- granted something; this one removes a read path that six migrations have
-- assumed, and it is the one change here that can break the product for real
-- users IN EITHER DIRECTION. Too wide and an operator still sees the whole
-- book of business. Too narrow and they cannot log the checkpoint they were
-- hired to log.
--
-- The owner's rule, verbatim: "the admin must see the entire operation of the
-- business, the operator must only see the dashboard of the shipment they are
-- assigned to."
--
-- Generalised to every role, because a rule with a hole in it is not a rule:
--
--   admin    — every shipment their organisation owns
--   operator — the shipments assigned to them, and nothing else
--   viewer   — the same, and nothing else
--   party    — unchanged: whatever a live grant names
--
-- A `viewer` is narrowed too, deliberately. It is tempting to leave internal
-- read-only staff with blanket access "because they cannot change anything",
-- but what this product sells is a view of a shipment — so the view IS the
-- asset, and a role that keeps blanket sight of it keeps the thing being
-- restricted.
--
-- WHY NARROWING `can_view_shipment()` ALONE WOULD HAVE DONE NOTHING. The
-- policies written in 0005 read:
--
--     is_org_member(org_id) or is_platform_admin() or can_view_shipment(id)
--
-- The first branch is what gives every member sight of everything, so a
-- narrowed predicate behind an `or` is simply never reached. The policies are
-- rewritten below to route the whole decision through the predicate. That is
-- the only way the narrowing has any effect at all, and it is why this
-- migration touches policies on five tables rather than one function.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- shipment_assignments
-- ===========================================================================
-- A join table, not an `assigned_to` column on `shipments`. Three reasons:
--
--   A shipment can have more than one operator — a long-haul load changes
--   hands at a depot, and both people need it on their board that day.
--
--   The project keeps history rather than deleting (compare
--   `shipment_parties.revoked_at` and `invitations.revoked_at`). "Who could
--   see this load, and when" is part of the oversight record.
--
--   A column would make "which shipments am I assigned to" — the single most
--   frequent question in this schema, asked on every page load by every
--   non-admin — a scan of `shipments` rather than an index seek from the user.

create table public.shipment_assignments (
  id uuid primary key default gen_random_uuid(),

  -- Denormalised, with the composite FK below proving it agrees with the
  -- shipment. Same reasoning as `checkpoints.org_id` in non-negotiable #5:
  -- without it, every assignment lookup becomes a join through the
  -- `shipments` policy, which is a two-hop RLS evaluation per row — on the
  -- query that runs most often.
  org_id      uuid not null,
  shipment_id uuid not null,

  user_id     uuid not null references auth.users (id) on delete cascade,
  assigned_by uuid not null references auth.users (id),

  -- A note on why, for the admin reading the history later.
  note text check (note is null or length(btrim(note)) between 1 and 280),

  -- Unassignment is a timestamp, not a delete, for the same reason revocation
  -- is one on a party grant.
  unassigned_at timestamptz,
  unassigned_by uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shipment_assignments_shipment_fkey
    foreign key (shipment_id, org_id)
    references public.shipments (id, org_id) on delete cascade,

  -- An unassigner implies an unassignment time, but NOT the reverse — the
  -- same one-directional shape as `tasks_completer_implies_completion`, and
  -- for the same reason: `auth.uid()` is null when a row is unassigned outside
  -- a user session, and "unassigned, by someone unknown" is a real state while
  -- "unassigned by someone, at no particular time" is not.
  constraint shipment_assignments_unassigner_implies_unassignment
    check (unassigned_by is null or unassigned_at is not null)
);

-- One live assignment per person per shipment. Re-assigning somebody who is
-- already on it is a no-op, not a duplicate row.
create unique index shipment_assignments_active_idx
  on public.shipment_assignments (shipment_id, user_id)
  where unassigned_at is null;

-- THE INDEX EVERY NON-ADMIN PAGE LOAD DEPENDS ON. `is_assigned_to_shipment()`
-- is called once per statement by policies on five tables; without this it is
-- a sequential scan of every assignment in the system, which at scale is a
-- timeout that looks exactly like a permissions bug.
create index shipment_assignments_user_idx
  on public.shipment_assignments (user_id, shipment_id)
  where unassigned_at is null;

-- The other direction: "who is on this load", for the admin's shipment page.
create index shipment_assignments_shipment_idx
  on public.shipment_assignments (shipment_id)
  where unassigned_at is null;

create trigger shipment_assignments_set_updated_at
  before update on public.shipment_assignments
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- Guards
-- ===========================================================================

-- An assignee must be a member of the owning organisation.
--
-- THIS CLOSES A CROSS-TENANT PATH, and a more direct one than the equivalent
-- guard on `tasks`: an assignment IS a read grant, so an admin who could name
-- an arbitrary uuid here would be handing their shipments to anyone whose id
-- they could guess — including a member of a competitor.
--
-- `security definer` for the same visibility reason given in
-- `tasks_guard_assignee`: `memberships` is self-or-admin on select, so the
-- check must not depend on the caller being able to see the row it needs.
create or replace function public.shipment_assignments_guard_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not exists (
    select 1 from public.memberships m
    where m.user_id = new.user_id
      and m.org_id = new.org_id
  ) then
    raise exception 'Cannot assign a shipment to someone outside the organisation'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

create trigger shipment_assignments_guard_assignee
  before insert or update on public.shipment_assignments
  for each row execute function public.shipment_assignments_guard_assignee();


-- Unassignment is stamped by the database, not supplied by the caller — the
-- same discipline as `checkpoints_stamp_recorded()` and
-- `tasks_stamp_completion()`.
create or replace function public.shipment_assignments_stamp_unassignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' and new.unassigned_at is not null and old.unassigned_at is null then
    new.unassigned_at := now();
    new.unassigned_by := coalesce((select auth.uid()), new.unassigned_by);
  elsif tg_op = 'UPDATE' and old.unassigned_at is not null then
    -- Already ended: keep the original stamp, ignore the caller. An
    -- assignment is re-opened by inserting a new row, which is what keeps the
    -- history readable as a sequence of spells rather than one mutable row.
    new.unassigned_at := old.unassigned_at;
    new.unassigned_by := old.unassigned_by;
  end if;

  return new;
end;
$fn$;

create trigger shipment_assignments_stamp_unassignment
  before update on public.shipment_assignments
  for each row execute function public.shipment_assignments_stamp_unassignment();


-- Whoever creates a shipment in the app is assigned to it.
--
-- WITHOUT THIS, NARROWING IS A TRAP: an operator may create a shipment —
-- `shipments_insert_staff` has always allowed it — and a moment later it
-- vanishes from their board, because they are not assigned to the thing they
-- just typed in. They would reasonably conclude the save failed and do it
-- again.
--
-- `auth.uid()` rather than `new.created_by`: this exists to keep the PERSON AT
-- THE KEYBOARD looking at their own work. A row inserted outside a user
-- session — a seed, the SQL editor, a future import — has no such person, and
-- inventing one would put a name against work nobody did.
create or replace function public.shipments_assign_creator()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  actor uuid := (select auth.uid());
begin
  if actor is null then
    return new;
  end if;

  insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by, note)
  values (new.org_id, new.id, actor, actor, 'Created this shipment')
  on conflict do nothing;

  return new;
end;
$fn$;

create trigger shipments_assign_creator
  after insert on public.shipments
  for each row execute function public.shipments_assign_creator();


-- ===========================================================================
-- The narrowed predicate
-- ===========================================================================
-- Same five rules as every definer predicate in 0001: security definer,
-- pinned search_path, stable, no user-id parameter, execute revoked from
-- public and anon.

create or replace function public.is_assigned_to_shipment(target_shipment uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.shipment_assignments a
    where a.shipment_id = target_shipment
      and a.user_id = (select auth.uid())
      and a.unassigned_at is null
      -- MEMBERSHIP IS RE-CHECKED HERE, and it is not redundant. Removing
      -- somebody from an organisation does not cascade to their assignments —
      -- the history is kept on purpose — so without this clause a dismissed
      -- employee would keep sight of every load they were ever given.
      and a.org_id = any (public.my_org_ids())
  );
$fn$;

-- Replaces the 0005 definition. The clause that read "my organisation owns
-- it" becomes "I am an ADMIN of the organisation that owns it"; everything
-- else in the organisation arrives through an assignment.
create or replace function public.can_view_shipment(target_shipment uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    -- An admin of the owning organisation. The whole operation, as asked.
    select 1
    from public.shipments s
    where s.id = target_shipment
      and public.has_org_role(s.org_id, array['admin']::public.membership_role[])
  )
  or public.is_assigned_to_shipment(target_shipment)
  or exists (
    -- ...or one of the caller's organisations holds a LIVE grant on it.
    -- Unchanged from 0005. `revoked_at is null` is still the load-bearing
    -- clause: without it, revoking access would do nothing at all, silently.
    select 1
    from public.shipment_parties p
    where p.shipment_id = target_shipment
      and p.revoked_at is null
      and p.party_org_id = any (public.my_org_ids())
  );
$fn$;

revoke execute on function public.is_assigned_to_shipment(uuid) from public, anon;
grant execute on function public.is_assigned_to_shipment(uuid) to authenticated;


-- ===========================================================================
-- shipment_assignments RLS
-- ===========================================================================

alter table public.shipment_assignments enable row level security;

-- Visible to the owning organisation's staff who can already see the shipment
-- — which is the admin, and the people on it.
--
-- NOTE WHAT IS ABSENT: no branch for a party organisation. A consignee may
-- watch the load; who inside the carrier is driving it is the carrier's
-- internal staffing, and nothing about the journey depends on it.
create policy shipment_assignments_select on public.shipment_assignments
  for select to authenticated using (
    public.is_platform_admin()
    or (public.is_org_member(org_id) and public.can_view_shipment(shipment_id))
  );

-- Only the owning organisation's admins may assign or unassign. An operator
-- assigning themselves would make the narrowing voluntary, which is the same
-- as not having it.
create policy shipment_assignments_insert_admin on public.shipment_assignments
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    and assigned_by = (select auth.uid())
  );
create policy shipment_assignments_update_admin on public.shipment_assignments
  for update to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );
-- No DELETE policy: assignments end with `unassigned_at`, never removed.

-- RLS filters rows; it cannot say "you may end this assignment but not move it
-- to another shipment". Column privileges can, and they apply in addition to
-- RLS — the same mechanism used on `organisations` in 0001 and `messages` in
-- 0007. Without this, `update ... set shipment_id = <another>` passes a
-- `with check` that only looks at `org_id`.
revoke update on public.shipment_assignments from authenticated;
grant update (unassigned_at, unassigned_by, note)
  on public.shipment_assignments to authenticated;


-- ===========================================================================
-- Narrowing the read path
-- ===========================================================================
-- The `is_org_member(org_id)` branch comes off every policy that guards
-- shipment data. That branch is the one being removed; leaving it anywhere
-- leaves the whole narrowing inert for that table.

drop policy shipments_select_viewer on public.shipments;
create policy shipments_select_assigned on public.shipments
  for select to authenticated using (
    public.is_platform_admin()
    or public.can_view_shipment(id)
  );

drop policy checkpoints_select_viewer on public.checkpoints;
create policy checkpoints_select_assigned on public.checkpoints
  for select to authenticated using (
    public.is_platform_admin()
    or public.can_view_shipment(shipment_id)
  );

-- DELIBERATELY NOT NARROWED: `locations` and `sa_places`.
--
-- An operator must still see their organisation's depots and the shared
-- gazetteer, or they cannot log a checkpoint at all — the pickup they are
-- confirming happened at a depot, and the depot list is how they name it.
-- Narrowing here would break the core loop while looking like tightened
-- security, which is the worst combination available.


-- ===========================================================================
-- Narrowing the write path
-- ===========================================================================
-- A read restriction with the write policies left alone is not a restriction.
-- `shipments_update_staff` and `checkpoints_insert_staff` as written in 0004
-- let any operator in the organisation edit any shipment — including one they
-- can no longer see, which is worse than seeing it: an invisible edit.

drop policy shipments_update_staff on public.shipments;
create policy shipments_update_assigned on public.shipments
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    and public.can_view_shipment(id)
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    and public.can_view_shipment(id)
  );

drop policy checkpoints_insert_staff on public.checkpoints;
create policy checkpoints_insert_assigned on public.checkpoints
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    and public.can_view_shipment(shipment_id)
  );

drop policy checkpoints_update_staff on public.checkpoints;
create policy checkpoints_update_assigned on public.checkpoints
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    and public.can_view_shipment(shipment_id)
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    and public.can_view_shipment(shipment_id)
  );

-- `shipments_insert_staff` is unchanged: you cannot be assigned to a shipment
-- that does not exist yet. `shipments_assign_creator` above is what makes that
-- safe rather than a trap.
--
-- `shipments_delete_admin` and `checkpoints_delete_admin` are unchanged: both
-- are admin-only already, and an admin sees the whole organisation.


-- ===========================================================================
-- The second-order leaks
-- ===========================================================================
-- Three tables describe a shipment without being one. Each would quietly hand
-- back what the policies above just took away.

-- Who else is watching this load, and under what role, is shipment data — the
-- customer list, in effect. The party side keeps its own view of its own
-- grants; that is the half of this policy that is not about narrowing.
drop policy shipment_parties_select on public.shipment_parties;
create policy shipment_parties_select_viewer on public.shipment_parties
  for select to authenticated using (
    public.is_platform_admin()
    or public.is_org_member(party_org_id)
    or (public.is_org_member(org_id) and public.can_view_shipment(shipment_id))
  );

-- Correspondence ABOUT a shipment is shipment data, and more sensitive than
-- most of it: this is where a customer says why the load matters. An org-wide
-- message (`shipment_id is null`) is internal staff traffic and stays visible
-- to the whole organisation.
drop policy messages_select on public.messages;
create policy messages_select_assigned on public.messages
  for select to authenticated using (
    (
      public.is_org_member(org_id)
      and (shipment_id is null or public.can_view_shipment(shipment_id))
    )
    or (
      counterparty_org_id is not null
      and public.is_org_member(counterparty_org_id)
      and public.can_view_shipment(shipment_id)
    )
  );

drop policy messages_insert on public.messages;
create policy messages_insert_assigned on public.messages
  for insert to authenticated with check (
    -- You are who you say you are. This is the forged-sender defence,
    -- unchanged from 0007 and the most important line in the policy.
    sender_user_id = (select auth.uid())
    and public.is_org_member(sender_org_id)
    and (
      -- The owning organisation's own staff. The only change from 0007: a
      -- shipment-scoped message now requires sight of that shipment, where it
      -- used to require only membership.
      (
        sender_org_id = org_id
        and case
              when shipment_id is null
                then public.has_org_role(org_id, array['admin']::public.membership_role[])
              else public.can_view_shipment(shipment_id)
            end
        and (
          counterparty_org_id is null
          or exists (
            select 1 from public.shipment_parties p
            where p.shipment_id = messages.shipment_id
              and p.org_id = messages.org_id
              and p.party_org_id = messages.counterparty_org_id
              and p.revoked_at is null
          )
        )
      )
      -- Or a live, messaging-enabled party, writing as itself. Unchanged.
      or exists (
        select 1 from public.shipment_parties p
        where p.shipment_id = messages.shipment_id
          and p.org_id = messages.org_id
          and p.party_org_id = messages.counterparty_org_id
          and p.party_org_id = messages.sender_org_id
          and p.messaging_enabled
          and p.revoked_at is null
      )
    )
  );

-- A task naming a shipment reveals that the shipment exists, what state it is
-- in and often where it is ("chase the POD at Harrismith"). An org-wide task
-- names no shipment and stays visible to everyone, as it was.
--
-- THE `assigned_to` BRANCH IS NEW, and 0007 argued against exactly this,
-- correctly at the time: the assignee is always a member, so the branch was
-- redundant. It stops being redundant here — an admin may hand an operator a
-- task about a shipment the operator is not assigned to, and without this
-- branch the task would be invisible to the one person meant to do it. The
-- task's title is visible; the shipment behind it still is not.
drop policy tasks_select_member on public.tasks;
create policy tasks_select_assigned on public.tasks
  for select to authenticated using (
    public.is_org_member(org_id)
    and (
      shipment_id is null
      or assigned_to = (select auth.uid())
      or public.can_view_shipment(shipment_id)
    )
  );

-- And the matching write: an operator cannot pin a task to a shipment they
-- cannot see. Closes the only path by which the `assigned_to` branch above
-- could be used to manufacture a view of one.
drop policy tasks_insert_staff on public.tasks;
create policy tasks_insert_assigned on public.tasks
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    and created_by = (select auth.uid())
    and (shipment_id is null or public.can_view_shipment(shipment_id))
  );


comment on table public.shipment_assignments is
  'Which members of the owning organisation may see and work a shipment. '
  'Admins see every shipment in their organisation without an assignment; '
  'every other role sees only what is assigned. Ended with unassigned_at, '
  'never deleted.';
