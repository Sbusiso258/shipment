-- 0005_parties.sql — who else can see this shipment.
--
-- THIS IS THE PRODUCT. Everything before it builds a system in which one
-- logistics business records its own shipments. This migration is what lets a
-- consignee, a consignor or a broker watch a load they do not own — which is
-- the thing the customer is actually paying for.
--
-- It is also the riskiest migration in the schema, which is why it arrives
-- last and alone. Every other table was sealed tenant-by-tenant; this one
-- deliberately opens a read path ACROSS tenants. When `npm run verify:rls`
-- fails after this, there is exactly one file to read.
--
-- THE ASYMMETRY IS THE WHOLE DESIGN: party organisations READ, and never
-- write. Any future policy granting a party insert, update or delete on a
-- shipment it does not own is a bug, not a feature request.
--
-- Forward-only. Never edit a migration that has been applied.


create type public.party_role as enum (
  'consignor', 'consignee', 'broker', 'carrier', 'insurer', 'notify_party', 'other'
);


-- ===========================================================================
-- shipment_parties
-- ===========================================================================

create table public.shipment_parties (
  id uuid primary key default gen_random_uuid(),

  -- The OWNING organisation, denormalised. Same reasoning as checkpoints:
  -- the composite FK proves it agrees with the shipment, and keeping it here
  -- means a policy on this table is one hop, not a join through another
  -- table's policy.
  org_id      uuid not null,
  shipment_id uuid not null,

  -- The organisation being granted visibility.
  party_org_id uuid not null references public.organisations (id) on delete cascade,
  party_role   public.party_role not null,

  granted_by uuid not null references auth.users (id),

  -- Revocation is a timestamp, not a delete. "You had visibility from the 4th
  -- to the 9th" is part of the oversight record, and a deleted row cannot say
  -- it. This is the opposite choice from a habit log, where absence already
  -- means "did not happen" — here, absence and withdrawal are different facts.
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shipment_parties_shipment_fkey
    foreign key (shipment_id, org_id)
    references public.shipments (id, org_id) on delete cascade,

  -- An organisation never needs a grant for its own shipment. Such a row would
  -- be a second, weaker read path to data it already owns — and the kind of
  -- thing that survives a refactor of the policy it was meant to complement.
  constraint shipment_parties_not_owner check (party_org_id <> org_id)
);

create unique index shipment_parties_active_idx
  on public.shipment_parties (shipment_id, party_org_id, party_role)
  where revoked_at is null;

-- THE INDEX THE ENTIRE VIEWER-SIDE READ PATH DEPENDS ON. Without it, every
-- query by a party organisation sequentially scans every grant in the system —
-- which is both slow and, at scale, a timeout that looks like a permissions
-- bug.
create index shipment_parties_lookup_idx
  on public.shipment_parties (party_org_id, shipment_id)
  where revoked_at is null;

create trigger shipment_parties_set_updated_at
  before update on public.shipment_parties
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- The cross-tenant read predicates
-- ===========================================================================
-- Same five rules as the predicates in 0001: security definer, pinned
-- search_path, stable, no user-id parameter, execute revoked from public and
-- anon. These two do the most dangerous work in the schema — read them
-- carefully, and re-run verify:rls after any change.

create or replace function public.can_view_shipment(target_shipment uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    -- The caller's own organisation owns it.
    select 1
    from public.shipments s
    where s.id = target_shipment
      and s.org_id = any (public.my_org_ids())
  )
  or exists (
    -- ...or one of the caller's organisations holds a LIVE grant on it.
    -- `revoked_at is null` is the load-bearing clause: without it, revoking
    -- access would do nothing at all, silently.
    select 1
    from public.shipment_parties p
    where p.shipment_id = target_shipment
      and p.revoked_at is null
      and p.party_org_id = any (public.my_org_ids())
  );
$fn$;

-- A party must be able to see a shipment's ORIGIN AND DESTINATION — a journey
-- with unnamed endpoints is not a journey. It must NOT thereby see the rest of
-- the owner's depots, which would hand a competitor their whole network.
--
-- So this is deliberately narrow: a location is visible to a party only while
-- it is an endpoint of, or a checkpoint on, a shipment that party can view.
create or replace function public.can_view_location(target_location uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.shipments s
    join public.shipment_parties p
      on p.shipment_id = s.id
     and p.revoked_at is null
     and p.party_org_id = any (public.my_org_ids())
    where s.origin_location_id = target_location
       or s.destination_location_id = target_location
  )
  or exists (
    select 1
    from public.checkpoints c
    join public.shipment_parties p
      on p.shipment_id = c.shipment_id
     and p.revoked_at is null
     and p.party_org_id = any (public.my_org_ids())
    where c.location_id = target_location
  );
$fn$;

-- A party needs the owning organisation's NAME to make sense of a shipment.
-- Nothing more.
create or replace function public.shares_shipment_with_org(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.shipment_parties p
    where p.revoked_at is null
      and p.org_id = target_org
      and p.party_org_id = any (public.my_org_ids())
  )
  or exists (
    select 1
    from public.shipment_parties p
    where p.revoked_at is null
      and p.party_org_id = target_org
      and p.org_id = any (public.my_org_ids())
  );
$fn$;

revoke execute on function public.can_view_shipment(uuid) from public, anon;
revoke execute on function public.can_view_location(uuid) from public, anon;
revoke execute on function public.shares_shipment_with_org(uuid) from public, anon;

grant execute on function public.can_view_shipment(uuid) to authenticated;
grant execute on function public.can_view_location(uuid) to authenticated;
grant execute on function public.shares_shipment_with_org(uuid) to authenticated;


-- ===========================================================================
-- shipment_parties RLS
-- ===========================================================================

alter table public.shipment_parties enable row level security;

-- Both sides of a grant can see it: the owner manages it, and the party has a
-- right to know what it has been given access to.
create policy shipment_parties_select on public.shipment_parties
  for select to authenticated using (
    public.is_org_member(org_id)
    or public.is_org_member(party_org_id)
    or public.is_platform_admin()
  );

-- Only the OWNING organisation's admins may grant or revoke. A party cannot
-- extend its own access, and cannot pass it on.
create policy shipment_parties_insert_owner_admin on public.shipment_parties
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );
create policy shipment_parties_update_owner_admin on public.shipment_parties
  for update to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );
-- No DELETE policy: grants are revoked with `revoked_at`, never removed.


-- ===========================================================================
-- Widening the read path
-- ===========================================================================
-- Only SELECT is touched. The insert, update and delete policies on these
-- tables are left exactly as they were, which is what makes "parties read,
-- never write" structural rather than a habit.

drop policy shipments_select_member on public.shipments;
create policy shipments_select_viewer on public.shipments
  for select to authenticated using (
    public.is_org_member(org_id)
    or public.is_platform_admin()
    or public.can_view_shipment(id)
  );

drop policy checkpoints_select_member on public.checkpoints;
create policy checkpoints_select_viewer on public.checkpoints
  for select to authenticated using (
    public.is_org_member(org_id)
    or public.is_platform_admin()
    or public.can_view_shipment(shipment_id)
  );

drop policy locations_select_member on public.locations;
create policy locations_select_viewer on public.locations
  for select to authenticated using (
    public.is_org_member(org_id)
    or public.is_platform_admin()
    or public.can_view_location(id)
  );

drop policy organisations_select_member on public.organisations;
create policy organisations_select_counterparty on public.organisations
  for select to authenticated using (
    public.is_org_member(id)
    or public.is_platform_admin()
    or public.shares_shipment_with_org(id)
  );
