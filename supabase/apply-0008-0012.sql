-- apply-0008-0012.sql — 5 migration(s), as one transaction.
--
-- GENERATED. Do not edit: edit the migrations and regenerate with
--   bash supabase/bundle-migration.sh 0008 0009 0010 0011 0012
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
-- 0008_assignment.sql
-- ============================================================
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

-- ============================================================
-- 0009_counterparty_lookup.sql
-- ============================================================
-- 0009_counterparty_lookup.sql — finding the customer you are about to share with.
--
-- THE PROBLEM THIS SOLVES, stated plainly: an admin cannot grant a
-- counterparty visibility of a shipment, because they cannot see that the
-- counterparty exists.
--
-- `organisations_select_counterparty` (0005) admits an organisation only when
-- the caller already SHARES a shipment with it. That is right — a tenant list
-- readable by every tenant would hand every carrier their competitors' client
-- book — but it is circular for the FIRST grant: you need the organisation's
-- id to create the grant, and the grant is what would let you read the id.
--
-- So the product today can only make a second grant to a customer who somehow
-- already has one. There is no screen that can create the first.
--
-- THE TRADE-OFF, WRITTEN DOWN RATHER THAN BURIED. This function lets an admin
-- learn that an organisation with a given slug exists. Slugs are chosen by
-- people and therefore low-entropy, so that is a real — if small —
-- enumeration oracle. It is bounded four ways:
--
--   exact match only, so it cannot be used to browse
--   one row maximum, so it cannot be used to count
--   three columns, so a hit reveals a name the customer already gave out
--   admins only, so an operator or a viewer cannot call it at all
--
-- The alternative was the platform owner wiring up every grant by hand, which
-- puts a person in the path of the product's core workflow. That is worse.
--
-- What this is NOT: a search. No prefix matching, no similarity, no listing.
-- Those would each turn a lookup into the directory this deliberately avoids.
--
-- Forward-only. Never edit a migration that has been applied.


create or replace function public.find_organisation_by_slug(target_slug text)
returns table (id uuid, name text, slug text)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  -- The authorisation check is the FIRST statement in the body, before any
  -- data is touched — the same shape as `org_members` in 0006. A definer
  -- function without one is an open door.
  --
  -- "An admin of some organisation", not "an admin of a particular one":
  -- the caller is looking for a counterparty precisely because no shipment
  -- links them yet, so there is no organisation to name here.
  if not exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid())
      and m.role = 'admin'
  ) then
    raise exception 'Only an organisation admin can look up a counterparty'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select o.id, o.name, o.slug
  from public.organisations o
  where o.slug = lower(btrim(target_slug))
    and o.status = 'active'
  limit 1;
end;
$fn$;

-- `revoke from public` does NOT take execute away from `anon` — Supabase's
-- default privileges grant it explicitly. This was a real bug in 0001 and the
-- revoke must name the role.
revoke execute on function public.find_organisation_by_slug(text) from public, anon;
grant execute on function public.find_organisation_by_slug(text) to authenticated;

comment on function public.find_organisation_by_slug(text) is
  'Resolves an exact organisation slug to an id, for an admin about to grant '
  'a counterparty visibility of a shipment. Exact match only, one row, three '
  'columns, admins only. Deliberately not a search.';

-- ============================================================
-- 0010_guard_cascade.sql
-- ============================================================
-- 0010_guard_cascade.sql — an organisation can be deleted again.
--
-- THE BUG, AND IT HAS BEEN THERE SINCE 0001: `delete from organisations`
-- fails for every organisation that has an admin. Which is every organisation,
-- because `memberships_guard_last_admin` refuses to let the last one go.
--
-- `memberships.org_id` carries `on delete cascade`, so deleting an
-- organisation deletes its memberships — and that cascade fires this BEFORE
-- DELETE trigger once per member. The guard then asks "would this organisation
-- be left with no admin?", finds the answer is yes, and raises:
--
--     Organisation <id> would be left with no admin   (check_violation)
--
-- The question is meaningless in that context. There is no organisation left
-- to leave without an admin; it is being deleted in the same statement.
--
-- WHAT THIS COST. `organisations_delete_platform` has existed since 0001 and
-- has never once been usable. The demo seed's own header told the owner to
-- clean up with `delete from public.organisations where slug =
-- 'demo-logistics'`, which would have failed with a constraint name and no
-- explanation. The "Remove demo data" control on /admin/setup would have
-- failed the same way — found by a PGlite rehearsal of that screen rather
-- than by the owner clicking it against their live project.
--
-- THE FIX is to let the guard notice that the parent is already gone.
-- Postgres runs `ON DELETE CASCADE` as an AFTER-ROW trigger on the parent, so
-- by the time this BEFORE-DELETE trigger runs on the child, the
-- `organisations` row is no longer visible in this transaction. Asking for it
-- is therefore an exact test of "is the organisation itself going?" — not a
-- heuristic.
--
-- The guard is `security definer`, so it sees the true state rather than
-- whatever the caller's policies admit. That matters here: an org admin
-- deleting their own organisation must get the same answer as the platform
-- owner.
--
-- WHAT IS DELIBERATELY NOT CHANGED: removing the last admin while the
-- organisation STAYS is still refused, and `verify-behaviour.sql` still
-- asserts it. That rule is what stops an organisation locking itself out, and
-- it is the reason this trigger exists at all.
--
-- Forward-only. Never edit a migration that has been applied.


create or replace function public.memberships_guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  remaining integer;
begin
  -- The organisation itself may be going. See the header: this trigger fires
  -- once per member during a cascade, and "left with no admin" has no meaning
  -- when there is nothing left.
  if tg_op = 'DELETE'
     and not exists (
       select 1 from public.organisations o where o.id = old.org_id
     )
  then
    return old;
  end if;

  -- Only the removal or demotion of an admin can empty the set.
  if tg_op = 'UPDATE' and old.role = 'admin' and new.role = 'admin' then
    return new;
  end if;
  if old.role <> 'admin' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  select count(*) into remaining
  from public.memberships
  where org_id = old.org_id
    and role = 'admin'
    and id <> old.id;

  if remaining = 0 then
    raise exception
      'Organisation % would be left with no admin', old.org_id
      using errcode = 'check_violation';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$fn$;

-- ============================================================
-- 0011_fleet.sql
-- ============================================================
-- 0011_fleet.sql — drivers and vehicles become things, not strings.
--
-- `shipments.driver_name` and `shipments.vehicle_registration` have been free
-- text since 0004. That was right while a shipment was the only noun in the
-- product: a driver was a label on a load, not something you managed.
--
-- It stops being right the moment anybody asks "which loads is Thabo on this
-- week" or "when is ND 123-456 due for a service". Free text cannot answer
-- either, because `Thabo Nkosi`, `T Nkosi` and `thabo nkosi ` are three
-- drivers, and a licence expiry has nowhere to live.
--
-- WHAT THIS DOES NOT DO: drop the two text columns. They hold real data on
-- rows that already exist, migrations here are forward-only, and the backfill
-- below cannot be certain that two spellings are one person. So the columns
-- stay as the historical record of what was typed, the FKs become what the
-- app reads and writes, and nobody should "tidy away" the former.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- drivers
-- ===========================================================================
-- Shaped on `locations` (0002) deliberately: same tenancy, same archive-rather
-- -than-delete, same policy set. A reader who knows one knows both.

create table public.drivers (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,

  full_name text not null check (length(btrim(full_name)) between 1 and 160),
  phone     text,

  licence_number text,
  licence_class  text,

  -- A `date`, and the second one in the schema after `promised_delivery_date`.
  -- Non-negotiable #10 reserves `date` for a day a human is held to, and a
  -- licence expires at the end of a day in the operator's own zone — not at
  -- 02:00 local when a UTC instant happens to roll over.
  licence_expiry date,

  notes       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- THE KEYSTONE, same as on `locations`. It lets `shipments` prove through
  -- one composite foreign key that a driver belongs to the same organisation
  -- as the load. Without it a shipment could point at another tenant's
  -- driver, which would leak that person's name to anybody who can read the
  -- shipment.
  unique (id, org_id)
);

-- One live driver per name per organisation. Archived ones are excluded, so
-- somebody who leaves and returns gets their row back rather than a clash.
create unique index drivers_org_name_idx
  on public.drivers (org_id, lower(btrim(full_name)))
  where archived_at is null;

create index drivers_org_idx on public.drivers (org_id) where archived_at is null;

create trigger drivers_set_updated_at
  before update on public.drivers
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- vehicles
-- ===========================================================================

create type public.vehicle_type as enum (
  'rigid', 'tractor', 'trailer', 'bakkie', 'van', 'other'
);

create table public.vehicles (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,

  registration text not null check (length(btrim(registration)) between 1 and 32),
  make         text,
  model        text,
  vehicle_type public.vehicle_type not null default 'other',

  -- `numeric`, never float, and the same precision as `shipments.weight_kg`
  -- so the two can be compared without a cast deciding the answer.
  capacity_kg numeric(12,3) check (capacity_kg is null or capacity_kg > 0),

  -- A day, for the same reason as `licence_expiry`.
  service_due date,

  notes       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (id, org_id)
);

-- Registrations are written down inconsistently — `ND 123-456`, `nd123456` —
-- so the uniqueness is on the stripped, folded form. Two spellings of one
-- plate are one vehicle.
create unique index vehicles_org_registration_idx
  on public.vehicles (org_id, upper(regexp_replace(registration, '[^A-Za-z0-9]', '', 'g')))
  where archived_at is null;

create index vehicles_org_idx on public.vehicles (org_id) where archived_at is null;

create trigger vehicles_set_updated_at
  before update on public.vehicles
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- shipments gains two references
-- ===========================================================================
-- Nullable, because a load can be recorded before anyone is assigned to drive
-- it, and because every existing row has no driver_id until the backfill runs.

alter table public.shipments
  add column driver_id  uuid,
  add column vehicle_id uuid;

alter table public.shipments
  add constraint shipments_driver_fkey
    foreign key (driver_id, org_id)
    references public.drivers (id, org_id) on delete no action,
  add constraint shipments_vehicle_fkey
    foreign key (vehicle_id, org_id)
    references public.vehicles (id, org_id) on delete no action;

-- `NO ACTION`, and the two alternatives are both worse.
--
-- NOT CASCADE: that would delete a company's delivery history because
-- somebody tidied up the staff list. The record of who carried what is the
-- product.
--
-- NOT `SET NULL`: on a COMPOSITE key, plain `set null` nulls EVERY column in
-- the key — including `org_id`, which is `not null`. The delete then fails
-- with "null value in column org_id violates not-null constraint", which
-- names a column nobody touched. Postgres 15 added `set null (driver_id)` to
-- fix exactly this, but pinning the schema to a server version for one
-- clause is a poor trade when NO ACTION says the right thing anyway.
--
-- NOT `RESTRICT`, which looks identical and is not: RESTRICT checks
-- immediately, NO ACTION checks at the END OF THE STATEMENT. Deleting an
-- organisation cascades into `drivers` and `shipments` both, in an order
-- Postgres does not promise — under RESTRICT, drivers going first would
-- abort the whole delete. This is the same trap 0010 had to undo on
-- `memberships_guard_last_admin`, and it is worth recognising on sight.
--
-- What it means in practice: a driver who has carried a load cannot be
-- deleted. Archive them. That is how everything else in this schema ends.

create index shipments_driver_idx on public.shipments (driver_id)
  where driver_id is not null;
create index shipments_vehicle_idx on public.shipments (vehicle_id)
  where vehicle_id is not null;


-- ===========================================================================
-- Backfill
-- ===========================================================================
-- One driver per distinct name per organisation, one vehicle per distinct
-- registration, then point the shipments at them.
--
-- MATCHED THE SAME WAY THE UNIQUE INDEXES MATCH, so the insert cannot produce
-- a row the index would then reject. Names fold on case and surrounding
-- space; registrations strip punctuation.
--
-- This is best-effort by nature: it cannot know that `T Nkosi` and
-- `Thabo Nkosi` are one person. It creates two drivers, and whoever runs the
-- business merges them by archiving one. Guessing would be worse — a
-- shipment reassigned to the wrong driver is a false record, and this product
-- is sold on not having those.

insert into public.drivers (org_id, full_name)
select distinct s.org_id, btrim(s.driver_name)
from public.shipments s
where s.driver_name is not null
  and btrim(s.driver_name) <> ''
on conflict do nothing;

insert into public.vehicles (org_id, registration)
select distinct s.org_id, btrim(s.vehicle_registration)
from public.shipments s
where s.vehicle_registration is not null
  and btrim(s.vehicle_registration) <> ''
on conflict do nothing;

update public.shipments s
set driver_id = d.id
from public.drivers d
where d.org_id = s.org_id
  and lower(btrim(d.full_name)) = lower(btrim(s.driver_name))
  and s.driver_name is not null
  and s.driver_id is null;

update public.shipments s
set vehicle_id = v.id
from public.vehicles v
where v.org_id = s.org_id
  and upper(regexp_replace(v.registration, '[^A-Za-z0-9]', '', 'g'))
    = upper(regexp_replace(s.vehicle_registration, '[^A-Za-z0-9]', '', 'g'))
  and s.vehicle_registration is not null
  and s.vehicle_id is null;


-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Identical in shape to `locations`, and for the same reasons. Every policy
-- scoped `to authenticated`; every UPDATE repeats its `using` as `with check`
-- so an admin cannot move a driver to another tenant.
--
-- DELIBERATELY NOT NARROWED BY ASSIGNMENT, unlike shipment data in 0008. An
-- operator picks a driver and a vehicle when recording a load; a picker that
-- only showed the fleet already on their own shipments would make the first
-- load of a new vehicle impossible to record. Same judgement as `locations`.

alter table public.drivers  enable row level security;
alter table public.vehicles enable row level security;

-- --- drivers ---------------------------------------------------------------
-- NOT widened to party organisations. A consignee watching a load has no
-- business holding the carrier's staff list, their phone numbers or their
-- licence numbers. The shipment carries `driver_name` for display; this table
-- is the employer's record.
create policy drivers_select_member on public.drivers
  for select to authenticated using (
    public.is_org_member(org_id) or public.is_platform_admin()
  );
create policy drivers_insert_staff on public.drivers
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy drivers_update_staff on public.drivers
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy drivers_delete_admin on public.drivers
  for delete to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );

-- --- vehicles --------------------------------------------------------------
create policy vehicles_select_member on public.vehicles
  for select to authenticated using (
    public.is_org_member(org_id) or public.is_platform_admin()
  );
create policy vehicles_insert_staff on public.vehicles
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy vehicles_update_staff on public.vehicles
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy vehicles_delete_admin on public.vehicles
  for delete to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );

comment on table public.drivers is
  'The people an organisation puts behind a wheel. shipments.driver_name is '
  'kept as the historical record of what was typed before 0011; driver_id is '
  'what the app reads.';

comment on table public.vehicles is
  'An organisation''s fleet. shipments.vehicle_registration is kept as the '
  'historical record of what was typed before 0011; vehicle_id is what the '
  'app reads.';

-- ============================================================
-- 0012_audit_and_guards.sql
-- ============================================================
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
