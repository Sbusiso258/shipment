-- apply-all.sql — every migration, in order, as one transaction.
--
-- GENERATED. Do not edit: edit the migrations and regenerate with
--   bash supabase/bundle-migrations.sh
--
-- Wrapped in BEGIN/COMMIT so it either all applies or none of it does.
-- Applying five files by hand means five chances to paste one out of order,
-- or to stop after three and leave a half-built schema that neither works nor
-- fails cleanly.

begin;


-- ============================================================
-- 0001_identity.sql
-- ============================================================
-- 0001_identity.sql — identity, tenancy and the access model.
--
-- This migration establishes four things every later migration depends on:
--
--   1. `organisations` — the tenant. Every ownable entity added later carries a
--      single NOT NULL `org_id`. Never a nullable one: a nullable tenant column
--      pushes NULL-handling into every query and every policy forever, and the
--      one place it is forgotten is the leak.
--
--   2. `platform_admins` — the root of trust, as a table of its own rather than
--      a fourth value in `membership_role`. An enum where three values mean
--      "what you may do inside an org" and a fourth means "you are above all
--      orgs" invites a policy that checks `role = 'owner'` on a membership row
--      that cannot exist. Keeping the two mechanisms physically separate makes
--      privilege escalation unrepresentable rather than merely unlikely.
--
--   3. The four `security definer` predicates. Every policy in this schema is
--      expressed in terms of them. See "the recursion trap" below.
--
--   4. The RLS pattern: every table, policies written in the same migration
--      that creates the table, every UPDATE carrying both `using` and
--      `with check`. Uniformity is the mitigation — a bespoke policy per table
--      is how one gets silently forgotten.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- Shared helpers
-- ===========================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create type public.membership_role as enum ('admin', 'operator', 'viewer');
create type public.org_status     as enum ('active', 'suspended');


-- ===========================================================================
-- profiles — one row per auth user
-- ===========================================================================

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  phone      text,
  -- IANA zone, never a fixed offset: South Africa does not observe DST today,
  -- but storing "+02:00" would be a lie the moment this crosses a border, and
  -- cross-border is an explicit roadmap item.
  timezone   text not null default 'Africa/Johannesburg',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- platform_admins — who may provision organisations
-- ===========================================================================

create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text,
  granted_at timestamptz not null default now()
);

-- NOTE: this table deliberately gets a SELECT policy and NOTHING ELSE.
-- With RLS enabled and no write policy, every insert, update and delete from
-- the application is denied — including from a platform admin. The first row is
-- created by hand in the Supabase SQL editor (the table owner bypasses its own
-- RLS), and so is every subsequent one. There is no screen for this on purpose:
-- a provisioning UI for the most privileged table in the system would be the
-- single highest-value target in the product.


-- ===========================================================================
-- organisations — the tenant
-- ===========================================================================

create table public.organisations (
  id     uuid primary key default gen_random_uuid(),
  name   text not null check (length(btrim(name)) between 1 and 160),
  -- Reserved for the future client-facing portal URL. Constrained now because
  -- adding a format constraint to a populated column means fixing rows first.
  slug   text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  status public.org_status not null default 'active',

  -- A subscriber records shipments. A non-subscriber is a counterparty that
  -- only ever views shipments shared with it — the consignee who needs to see
  -- where the load is and nothing else.
  is_subscriber boolean not null default false,

  registration_number text,
  contact_email       text
    check (contact_email is null or contact_email = lower(btrim(contact_email))),

  -- The zone lateness is judged in. A delivery promised "Thursday" is late at
  -- the end of Thursday *here*, not at 02:00 on the server.
  timezone text not null default 'Africa/Johannesburg',

  -- How many days of no checkpoint before a shipment is reported as silent.
  -- An operational judgement, so it belongs to the customer, not to the code.
  default_silence_threshold_days smallint not null default 2
    check (default_silence_threshold_days between 1 and 30),

  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Lets a future table prove through one composite FK that its parent org is
  -- active. Costs an index now; removes a migration later.
  unique (id, status)
);

create trigger organisations_set_updated_at
  before update on public.organisations
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- memberships — who is in which organisation, and what they may do
-- ===========================================================================

create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organisations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.membership_role not null,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One role per person per org. Two rows would make "what may they do" a
  -- reduce rather than a lookup, and the reduce would eventually disagree with
  -- itself somewhere.
  unique (org_id, user_id)
);

-- The index the entire RLS design rests on: every policy evaluation in this
-- schema does one lookup here.
create index memberships_user_idx on public.memberships (user_id);
create index memberships_org_role_idx on public.memberships (org_id, role);
create index memberships_org_admin_idx on public.memberships (org_id)
  where role = 'admin';

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- invitations — owner-controlled access, with no service-role key
-- ===========================================================================

create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations (id) on delete cascade,
  email       text not null
    check (email = lower(btrim(email)) and position('@' in email) > 1),
  role        public.membership_role not null,
  invited_by  uuid not null references auth.users (id),
  expires_at  timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at  timestamptz,
  revoked_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index invitations_pending_idx
  on public.invitations (org_id, email)
  where accepted_at is null and revoked_at is null;

-- Read by handle_new_user() on every signup.
create index invitations_email_idx
  on public.invitations (email)
  where accepted_at is null and revoked_at is null;

create trigger invitations_set_updated_at
  before update on public.invitations
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- The recursion trap, and the predicates that break it
-- ===========================================================================
--
-- A policy on `shipments` must ask "is the caller a member of the owning org?",
-- which reads `memberships`. A policy on `memberships` that also reads
-- `memberships` — so that an org admin can see co-members — recurses, and
-- Postgres raises 42P17 `infinite recursion detected in policy for relation
-- "memberships"`. Policies ARE applied to tables referenced inside other
-- policies' expressions; that is the entire mechanism. Nothing about the
-- `shipments` policy looks wrong, and the error surfaces on an unrelated query.
--
-- The fix is a `security definer` function: it runs as its owner, so reading
-- `memberships` inside it does not re-enter that table's policy.
--
-- FIVE RULES GOVERN EVERY ONE OF THESE FUNCTIONS. All five are load-bearing:
--
--   1. `security definer` — this is what breaks the cycle.
--   2. `set search_path = public` — without it, a caller who can create a
--      schema can shadow `public.memberships` and the function reads THEIR
--      table instead. This is the standard definer escalation.
--   3. `stable`, not `volatile` — lets the planner evaluate once per statement
--      rather than once per row. With the `(select auth.uid())` subquery form,
--      a policy costs one index lookup per statement.
--   4. NO USER-ID PARAMETER, EVER. Each reads `(select auth.uid())` itself. A
--      `has_org_role(user_id, org_id)` signature would be an oracle any
--      authenticated caller could query about anybody, and it would bypass RLS
--      by design — the single worst line this codebase could contain.
--   5. `execute` revoked from `public`, granted to `authenticated` only.
--
-- These functions bypass RLS. That is the point, and it is also the price:
-- `npm run verify:rls` exists because `verify:migrations` cannot prove any of
-- this. Changing one of these functions is a security change.
-- ===========================================================================

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.platform_admins
    where user_id = (select auth.uid())
  );
$fn$;

create or replace function public.my_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(array_agg(org_id), '{}'::uuid[])
  from public.memberships
  where user_id = (select auth.uid());
$fn$;

create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.memberships
    where org_id = target_org
      and user_id = (select auth.uid())
  );
$fn$;

create or replace function public.has_org_role(
  target_org uuid,
  allowed public.membership_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.memberships
    where org_id = target_org
      and user_id = (select auth.uid())
      and role = any (allowed)
  );
$fn$;

-- REVOKING FROM `public` IS NOT ENOUGH, and this was found the hard way by
-- `npm run verify:rls`, which caught `anon` successfully calling both
-- predicates after exactly the revoke below.
--
-- A Supabase project ships with default privileges that grant EXECUTE on every
-- new function in `public` to anon, authenticated and service_role. `anon`
-- therefore holds its OWN explicit grant, which a revoke from the PUBLIC
-- pseudo-role does not touch. These functions deliberately bypass RLS, so a
-- signed-out visitor must not be able to call them — today they would return
-- nothing, but `can_view_shipment()` joins this family in a later migration
-- and the same oversight there would be a real leak.
revoke execute on function public.is_platform_admin() from public, anon;
revoke execute on function public.my_org_ids() from public, anon;
revoke execute on function public.is_org_member(uuid) from public, anon;
revoke execute on function public.has_org_role(uuid, public.membership_role[]) from public, anon;

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.my_org_ids() to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_org_role(uuid, public.membership_role[]) to authenticated;


-- ===========================================================================
-- Guard: an organisation must never lose its last admin
-- ===========================================================================
-- Without this an org locks itself out — the remaining members cannot invite
-- anyone, and only a platform admin can repair it from the SQL editor.

create or replace function public.memberships_guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  remaining integer;
begin
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

create trigger memberships_guard_last_admin
  before update or delete on public.memberships
  for each row execute function public.memberships_guard_last_admin();


-- ===========================================================================
-- New-user bootstrap
-- ===========================================================================
-- There is no service-role key in this project, so users cannot be created
-- programmatically. The platform owner creates the auth user in the Supabase
-- dashboard; this trigger turns any pending invitation for that email address
-- into a membership.
--
-- ONE trigger on auth.users, extended in place. Never a second one: two
-- triggers on the same event have undefined relative order.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;

  -- Every pending, unexpired invitation matching this address becomes a
  -- membership. Matching on the email Supabase verified, never on anything the
  -- user supplied in metadata.
  insert into public.memberships (org_id, user_id, role, invited_by)
  select i.org_id, new.id, i.role, i.invited_by
  from public.invitations i
  where i.email = lower(btrim(new.email))
    and i.accepted_at is null
    and i.revoked_at is null
    and (i.expires_at is null or i.expires_at > now())
  on conflict (org_id, user_id) do nothing;

  update public.invitations
  set accepted_at = now(),
      accepted_by = new.id
  where email = lower(btrim(new.email))
    and accepted_at is null
    and revoked_at is null
    and (expires_at is null or expires_at > now());

  return new;
end;
$fn$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ===========================================================================
-- Row Level Security
-- ===========================================================================
--
-- EVERY POLICY IS SCOPED `to authenticated`, and that is load-bearing in two
-- ways that `npm run verify:rls` demonstrated rather than assumed.
--
-- First: a policy expression is evaluated AS THE QUERYING ROLE. An unscoped
-- policy that calls `public.is_org_member(...)` therefore requires `anon` to
-- hold EXECUTE on that function — so locking the definer predicates away from
-- anonymous callers and leaving the policies unscoped are mutually exclusive.
-- Scoping the policies is the version that keeps both properties.
--
-- Second: with RLS enabled and no policy applicable to `anon`, an anonymous
-- request matches nothing and reads nothing. The denial is structural, rather
-- than depending on `auth.uid()` being null inside an expression that we got
-- right. This application has no anonymous access at all; when the public
-- tracking portal arrives it gets ONE new, deliberate, single-purpose policy
-- keyed on a token, not a widening of these.

alter table public.profiles        enable row level security;
alter table public.platform_admins enable row level security;
alter table public.organisations   enable row level security;
alter table public.memberships     enable row level security;
alter table public.invitations     enable row level security;

-- --- profiles --------------------------------------------------------------
-- Deliberately NOT widened to "anyone who shares an org with me". The team
-- screen needs colleagues' names and emails; that is served by a narrow
-- `security definer` RPC returning exactly those columns, not by exposing
-- every profile column to every colleague forever.
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()) or public.is_platform_admin());
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = (select auth.uid()))
          with check (id = (select auth.uid()));

-- --- platform_admins -------------------------------------------------------
-- SELECT only. See the note on the table above.
create policy platform_admins_select_own on public.platform_admins
  for select to authenticated using (
    user_id = (select auth.uid()) or public.is_platform_admin()
  );

-- --- organisations ---------------------------------------------------------
-- The SELECT policy is widened in a later migration so that an organisation
-- which is party to a shipment can read the owning organisation's name.
create policy organisations_select_member on public.organisations
  for select to authenticated using (
    public.is_org_member(id) or public.is_platform_admin()
  );
create policy organisations_insert_platform on public.organisations
  for insert to authenticated with check (public.is_platform_admin());
create policy organisations_update_admin on public.organisations
  for update to authenticated using (
    public.has_org_role(id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  )
  with check (
    public.has_org_role(id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  );
create policy organisations_delete_platform on public.organisations
  for delete to authenticated using (public.is_platform_admin());

-- RLS filters rows; it cannot say "you may edit the name but not the
-- suspension status". Column privileges can, and they are a separate mechanism
-- that applies in addition to RLS. So an org admin may edit their own org's
-- details, and `status`, `slug` and `is_subscriber` stay out of reach.
revoke update on public.organisations from authenticated;
grant update (
  name,
  registration_number,
  contact_email,
  timezone,
  default_silence_threshold_days
) on public.organisations to authenticated;

-- --- memberships -----------------------------------------------------------
-- NOTE the absence of any self-insert path. A user cannot add themselves to an
-- organisation; that is precisely what makes access owner-controlled rather
-- than self-service.
create policy memberships_select_self_or_admin on public.memberships
  for select to authenticated using (
    user_id = (select auth.uid())
    or public.has_org_role(org_id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  );
create policy memberships_insert_admin on public.memberships
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  );
create policy memberships_update_admin on public.memberships
  for update to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  )
  with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  );
create policy memberships_delete_admin on public.memberships
  for delete to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  );

-- --- invitations -----------------------------------------------------------
-- Revocation is `revoked_at`, not a delete: who was invited and withdrawn is
-- part of the access record.
create policy invitations_select_admin on public.invitations
  for select to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  );
create policy invitations_insert_admin on public.invitations
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  );
create policy invitations_update_admin on public.invitations
  for update to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  )
  with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  );

-- ============================================================
-- 0002_locations.sql
-- ============================================================
-- 0002_locations.sql — places on the map.
--
-- Two tables with different jobs, and the distinction matters:
--
--   `sa_places`  is a shared, read-only gazetteer: real South African places
--                with real coordinates, identical for every tenant. It is what
--                removes the geocoding dependency — an operator picks a place
--                instead of typing an address that something has to resolve.
--
--   `locations`  is an organisation's own named places: its depots, its
--                customers' sites, its yards. Tenant-scoped, editable.
--
-- A location may carry its own exact coordinates, or lean on the gazetteer
-- entry for the town it sits in. The `location_points` view resolves which,
-- and — this is the part that matters — reports WHICH ONE IT USED, so the
-- interface can say "Nelspruit (approximate — town centre)" rather than
-- implying a surveyed position.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- sa_places — the gazetteer
-- ===========================================================================

create type public.place_kind as enum ('city', 'town', 'port', 'airport', 'border_post');

create table public.sa_places (
  id        uuid primary key default gen_random_uuid(),
  slug      text not null unique,
  name      text not null check (length(btrim(name)) between 1 and 160),

  latitude  numeric(9,6) not null,
  longitude numeric(9,6) not null,

  kind      public.place_kind not null,

  -- Cross-border seam. V1 is South Africa only, but the day Beitbridge and
  -- Harare matter they are rows in this table rather than a second gazetteer.
  -- Note that `border_post` already exists in the enum above for the same
  -- reason: adding an enum value later is a migration, and this costs nothing.
  country_code char(2) not null default 'ZA'
    check (country_code ~ '^[A-Z]{2}$'),

  -- Provenance. Every coordinate in this product must be traceable to a real
  -- source; this is how any single row can be checked against it.
  wikidata_qid text check (wikidata_qid is null or wikidata_qid ~ '^Q[0-9]+$'),

  created_at timestamptz not null default now(),

  -- Sanity, independent of country.
  constraint sa_places_on_earth
    check (latitude between -90 and 90 and longitude between -180 and 180),

  -- South African coordinates specifically. Expressed so that a row for
  -- another country simply skips it rather than needing the constraint
  -- dropped later.
  --
  -- The latitude half earns its keep on its own: every South African latitude
  -- is negative, so a positive one is ALWAYS a swapped or sign-dropped pair.
  -- That mistake is invisible on inspection — the number looks plausible — and
  -- the point lands in the Mediterranean.
  constraint sa_places_within_south_africa
    check (
      country_code <> 'ZA'
      or (latitude between -35.0 and -22.0 and longitude between 16.0 and 33.1)
    )
);

-- The type-ahead is a prefix search on a lowered name.
create index sa_places_name_idx on public.sa_places (lower(name));
create index sa_places_kind_idx on public.sa_places (kind);

-- NOTE: there is deliberately no `province` column yet.
--
-- Wikidata's administrative hierarchy for South African settlements resolves
-- to municipalities rather than provinces, and the query that walks up to the
-- province times out at this scale. Rather than ship a column that is null for
-- most rows, or — far worse — infer a province from a bounding box and present
-- the guess as fact, the column waits for a source that can fill it. It is
-- recorded in docs/open-questions.md.


-- ===========================================================================
-- locations — an organisation's own places
-- ===========================================================================

create type public.location_kind as enum (
  'depot', 'warehouse', 'customer_site', 'port', 'airport', 'yard', 'other'
);

create table public.locations (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,

  name   text not null check (length(btrim(name)) between 1 and 160),
  kind   public.location_kind not null default 'other',

  -- The containing town. Used as the coordinate fallback, and as the thing an
  -- operator actually picks when creating a location.
  sa_place_id uuid references public.sa_places (id) on delete set null,

  address_line text,
  suburb       text,
  city         text,
  postal_code  text,

  -- An exact position, when one is known: pasted from a phone's share-sheet,
  -- or dropped on the map. Never geocoded — see AGENTS.md.
  latitude  numeric(9,6),
  longitude numeric(9,6),

  country_code char(2) not null default 'ZA' check (country_code ~ '^[A-Z]{2}$'),

  notes       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Half a coordinate is worse than none: it renders as a point on the
  -- equator or fails silently, depending on which half survived.
  constraint locations_coords_paired
    check ((latitude is null) = (longitude is null)),

  constraint locations_on_earth
    check (
      latitude is null
      or (latitude between -90 and 90 and longitude between -180 and 180)
    ),

  constraint locations_within_south_africa
    check (
      country_code <> 'ZA'
      or latitude is null
      or (latitude between -35.0 and -22.0 and longitude between 16.0 and 33.1)
    ),

  -- Lets `shipments` prove through one composite FK that an endpoint belongs
  -- to the same organisation as the shipment. Without it, a shipment could
  -- reference another tenant's depot — which leaks that depot's name and
  -- position to anyone who can read the shipment.
  unique (id, org_id)
);

create unique index locations_org_name_idx
  on public.locations (org_id, lower(btrim(name)))
  where archived_at is null;

create index locations_org_idx on public.locations (org_id) where archived_at is null;
create index locations_place_idx on public.locations (sa_place_id) where sa_place_id is not null;

create trigger locations_set_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- location_points — effective coordinates, and their provenance
-- ===========================================================================
-- A view rather than a trigger-maintained column, because this is a COALESCE
-- and not a judgement. The rule for this codebase: views may coalesce, never
-- judge. Anything that decides something — late, at risk, silent — lives in
-- src/lib as a pure function instead.
--
-- `security_invoker = true` matters twice. The underlying `locations` policies
-- still apply, so the view cannot be used to read another tenant's depots;
-- and Supabase's database linter flags security-definer views, so this stays
-- clean.

create view public.location_points
  with (security_invoker = true) as
select
  l.id      as location_id,
  l.org_id,
  l.name,
  l.kind,
  coalesce(l.latitude,  p.latitude)  as effective_latitude,
  coalesce(l.longitude, p.longitude) as effective_longitude,
  case
    when l.latitude is not null then 'exact'
    when p.latitude is not null then 'place'
    else 'unknown'
  end as coordinate_source,
  p.name as place_name,
  l.archived_at
from public.locations l
left join public.sa_places p on p.id = l.sa_place_id;


-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Every policy is scoped `to authenticated`. See the note in 0001.

alter table public.sa_places enable row level security;
alter table public.locations enable row level security;

-- --- sa_places -------------------------------------------------------------
-- Shared reference data: readable by every signed-in user, writable by none.
-- There is deliberately NO insert, update or delete policy. The gazetteer
-- changes by migration, which keeps it identical for every tenant and means a
-- customer cannot move a town.
create policy sa_places_select_authenticated on public.sa_places
  for select to authenticated using (true);

-- --- locations -------------------------------------------------------------
-- The SELECT policy is widened in a later migration so that an organisation
-- which is party to a shipment can read that shipment's endpoints — and only
-- those, never the rest of the owner's depots.
create policy locations_select_member on public.locations
  for select to authenticated using (
    public.is_org_member(org_id) or public.is_platform_admin()
  );
create policy locations_insert_staff on public.locations
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy locations_update_staff on public.locations
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy locations_delete_admin on public.locations
  for delete to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );

-- ============================================================
-- 0003_sa_places_seed.sql
-- ============================================================
-- 0003_sa_places_seed.sql — the South African gazetteer.
--
-- GENERATED, NOT HAND-WRITTEN. See docs/data-sources.md.
--
-- Source:  Wikidata (https://www.wikidata.org), via the public SPARQL endpoint.
-- Licence: CC0 1.0 — public domain dedication. No attribution obligation, which
--          is why Wikidata was chosen over GeoNames (CC-BY): this project
--          already carries the basemap's attribution requirement and did not
--          need a second one on the data.
-- Fetched: 2026-11-03
-- Rows:    521
--
-- WHY THIS FILE EXISTS AT ALL
-- Every coordinate in this product must be real. A fabricated latitude renders
-- with exactly the same confidence as a surveyed one, and nobody double-checks
-- a pin that looks about right. So no coordinate here was typed from memory:
-- each one came from the query recorded in docs/data-sources.md, and each row
-- carries its Wikidata id so any value can be traced back to its source.
--
-- `kind` is the one derived field. Wikidata's own typing decides port and
-- airport; everything else is a city above 150 000 residents and a town below.
-- That is a stated rule applied uniformly, not a judgement made per row.
--
-- Re-running this migration is safe: it conflicts on slug and does nothing.

insert into public.sa_places (slug, name, latitude, longitude, kind, wikidata_qid) values
  ('abbotsford-johannesburg', 'Abbotsford, Johannesburg', -26.143100, 28.066200, 'town', 'Q4664288'),
  ('adelaide-airport', 'Adelaide Airport', -32.683327, 26.300007, 'airport', 'Q20449674'),
  ('aeroton', 'Aeroton', -26.253333, 27.974722, 'town', 'Q4688491'),
  ('aggeneys-airport', 'Aggeneys Airport', -29.281667, 18.813611, 'airport', 'Q4692191'),
  ('alan-manor', 'Alan Manor', -26.277500, 27.993333, 'town', 'Q4707236'),
  ('alberton', 'Alberton', -26.267222, 28.121944, 'town', 'Q1637702'),
  ('albertskroon', 'Albertskroon', -26.161111, 27.973889, 'town', 'Q4712277'),
  ('albertville', 'Albertville', -26.164444, 27.976944, 'town', 'Q4712299'),
  ('aldara-park', 'Aldara Park', -26.134000, 27.981000, 'town', 'Q4713440'),
  ('alexander-bay-airport', 'Alexander Bay Airport', -28.573333, 16.534444, 'airport', 'Q3545310'),
  ('aliwal-north', 'Aliwal North', -30.700000, 26.700000, 'town', 'Q2143142'),
  ('allen-grove', 'Allen Grove', -26.082000, 28.232000, 'town', 'Q2657161'),
  ('amandawe', 'Amandawe', -30.254749, 30.718646, 'town', 'Q115822163'),
  ('amsterdamhoek', 'Amsterdamhoek', -33.849167, 25.610833, 'town', 'Q97170053'),
  ('andrew-s-field-airport', 'Andrew''s Field Airport', -34.762700, 20.037300, 'airport', 'Q109228852'),
  ('arcadia', 'Arcadia', -25.746000, 28.221000, 'town', 'Q1752035'),
  ('arnot-power-station-airport', 'Arnot Power Station Airport', -25.943778, 29.810138, 'airport', 'Q20456113'),
  ('athlone', 'Athlone', -33.961111, 18.503056, 'town', 'Q4815602'),
  ('atlantis', 'Atlantis', -33.566667, 18.483333, 'town', 'Q3493630'),
  ('atteridgeville', 'Atteridgeville', -25.773333, 28.071389, 'town', 'Q1639345'),
  ('baardskeerdersbos', 'Baardskeerdersbos', -34.588889, 19.570833, 'town', 'Q3642686'),
  ('bakoven', 'Bakoven', -33.963000, 18.382000, 'town', 'Q15196202'),
  ('bantry-bay', 'Bantry Bay', -33.927500, 18.380278, 'town', 'Q2883519'),
  ('barberton-airport', 'Barberton Airport', -25.717500, 30.975000, 'airport', 'Q2785255'),
  ('barrydale', 'Barrydale', -33.900000, 20.733333, 'town', 'Q809120'),
  ('beacon-valley', 'Beacon Valley', -34.040000, 18.625000, 'town', 'Q108704157'),
  ('beaufort-west', 'Beaufort West', -32.350000, 22.583333, 'town', 'Q813395'),
  ('beaufort-west-airport', 'Beaufort West Airport', -32.300000, 22.666667, 'airport', 'Q20462742'),
  ('beitbridge', 'Beitbridge', -22.231000, 29.987000, 'town', 'Q15198168'),
  ('bela-bela', 'Bela-Bela', -24.885000, 28.294167, 'town', 'Q815085'),
  ('belhar', 'Belhar', -33.950000, 18.633300, 'town', 'Q3643522'),
  ('bellville', 'Bellville', -33.900000, 18.633333, 'town', 'Q816070'),
  ('benmore-gardens', 'Benmore Gardens', -26.090833, 28.046389, 'town', 'Q4889581'),
  ('benoni', 'Benoni', -26.188333, 28.320556, 'city', 'Q818106'),
  ('benoni-airport', 'Benoni Airport', -26.238055, 28.305833, 'airport', 'Q20463359'),
  ('berea', 'Berea', -29.851850, 30.993370, 'town', 'Q31879802'),
  ('bergvliet', 'Bergvliet', -34.045833, 18.454167, 'town', 'Q2897143'),
  ('bethal', 'Bethal', -26.450000, 29.450000, 'town', 'Q747174'),
  ('bethal-airport', 'Bethal Airport', -26.483352, 29.450022, 'airport', 'Q20463631'),
  ('bethlehem', 'Bethlehem', -28.233333, 28.300000, 'town', 'Q831326'),
  ('bethlehem-airport', 'Bethlehem Airport', -28.248611, 28.336111, 'airport', 'Q620071'),
  ('bishop-lavis', 'Bishop Lavis', -33.948600, 18.575800, 'town', 'Q4917624'),
  ('bishopscourt', 'Bishopscourt', -33.990278, 18.445833, 'town', 'Q936777'),
  ('bizana-airport', 'Bizana Airport', -30.866667, 29.866667, 'airport', 'Q12691943'),
  ('blackheath', 'Blackheath', -26.133333, 27.966667, 'town', 'Q879903'),
  ('blikkiesdorp', 'Blikkiesdorp', -33.981000, 18.631000, 'town', 'Q4926478'),
  ('bloemfontein', 'Bloemfontein', -29.100000, 26.216667, 'city', 'Q37701'),
  ('bloemfontein-airport', 'Bloemfontein Airport', -29.093889, 26.303889, 'airport', 'Q598282'),
  ('bloubergstrand', 'Bloubergstrand', -33.797200, 18.462000, 'town', 'Q2907090'),
  ('bo-kaap', 'Bo-Kaap', -33.920833, 18.412500, 'town', 'Q2418250'),
  ('bonteheuwel', 'Bonteheuwel', -33.951000, 18.554000, 'town', 'Q4942612'),
  ('boshof', 'Boshof', -28.558090, 25.241920, 'airport', 'Q31882561'),
  ('bothasig', 'Bothasig', -33.859400, 18.539700, 'town', 'Q2911666'),
  ('bothaville-airport', 'Bothaville Airport', -27.366667, 26.633333, 'airport', 'Q20464793'),
  ('braamfontein', 'Braamfontein', -26.191111, 28.037778, 'town', 'Q896447'),
  ('brackenfell', 'Brackenfell', -33.866667, 18.683333, 'town', 'Q4805472'),
  ('brakpan', 'Brakpan', -26.235278, 28.370000, 'town', 'Q897489'),
  ('brandvlei', 'Brandvlei', -30.463333, 20.486111, 'town', 'Q898384'),
  ('bredasdorp', 'Bredasdorp', -34.533333, 20.041667, 'town', 'Q1640898'),
  ('brits', 'Brits', -25.616667, 27.766667, 'town', 'Q3948'),
  ('brits-airfield', 'Brits Airfield', -25.532333, 27.774847, 'airport', 'Q4971523'),
  ('bronkhorstspruit', 'Bronkhorstspruit', -25.805000, 28.746389, 'town', 'Q927671'),
  ('bryanston', 'Bryanston', -26.048611, 28.033889, 'town', 'Q4980509'),
  ('bultfontein-airport', 'Bultfontein Airport', -28.272600, 26.136600, 'airport', 'Q139713474'),
  ('burgersdorp-airport', 'Burgersdorp Airport', -30.983333, 26.300000, 'airport', 'Q12692059'),
  ('caledon', 'Caledon', -34.230000, 19.428333, 'town', 'Q777884'),
  ('calvinia-airport', 'Calvinia Airport', -31.499920, 19.726600, 'airport', 'Q12692093'),
  ('camden', 'Camden', -26.599180, 30.088450, 'town', 'Q66492876'),
  ('camps-bay', 'Camps Bay', -33.950000, 18.383333, 'town', 'Q2935571'),
  ('cape-town', 'Cape Town', -33.925278, 18.423889, 'city', 'Q5465'),
  ('cape-town-cbd', 'Cape Town CBD', -33.916667, 18.683333, 'town', 'Q134710958'),
  ('cape-town-international-airport', 'Cape Town International Airport', -33.969444, 18.597222, 'airport', 'Q854130'),
  ('capri-village', 'Capri Village', -34.135278, 18.386667, 'town', 'Q4818778'),
  ('carletonville', 'Carletonville', -26.358056, 27.398056, 'town', 'Q536114'),
  ('carletonville-airport', 'Carletonville Airport', -26.369443, 27.350167, 'airport', 'Q12692127'),
  ('carnarvon-airport', 'Carnarvon Airport', -30.987500, 22.130556, 'airport', 'Q5043787'),
  ('carolina-airport', 'Carolina Airport', -26.078300, 30.092610, 'airport', 'Q12692133'),
  ('cato-manor', 'Cato Manor', -29.866667, 30.950000, 'town', 'Q379223'),
  ('cato-ridge', 'Cato Ridge', -29.733333, 30.583333, 'town', 'Q4217424'),
  ('centurion', 'Centurion', -25.860278, 28.189444, 'city', 'Q1054450'),
  ('century-city', 'Century City', -33.891667, 18.508333, 'town', 'Q5063139'),
  ('ceres', 'Ceres', -33.366667, 19.316667, 'town', 'Q2038408'),
  ('chatsworth', 'Chatsworth', -29.910000, 30.885000, 'town', 'Q3347036'),
  ('chief-dawid-stuurman-international-airpo', 'Chief Dawid Stuurman International Airport', -33.990000, 25.610278, 'airport', 'Q1432442'),
  ('citrusdal', 'Citrusdal', -32.589444, 19.014722, 'town', 'Q1003362'),
  ('city-bowl', 'City Bowl', -33.933300, 18.416700, 'town', 'Q2974549'),
  ('city-of-cape-town', 'City of Cape Town', -34.000000, 18.500000, 'city', 'Q1185115'),
  ('clanwilliam', 'Clanwilliam', -32.178611, 18.891111, 'town', 'Q1025657'),
  ('claremont', 'Claremont', -33.980556, 18.465278, 'town', 'Q2975541'),
  ('clarina', 'Clarina', -25.650000, 28.116667, 'town', 'Q112567981'),
  ('clifton', 'Clifton', -33.939939, 18.375881, 'town', 'Q2979103'),
  ('clovelly', 'Clovelly', -34.122222, 18.430556, 'town', 'Q16890495'),
  ('colesberg', 'Colesberg', -30.716667, 25.100000, 'town', 'Q2232441'),
  ('colesberg-airport', 'Colesberg Airport', -30.732493, 25.069440, 'airport', 'Q12692280'),
  ('colorado-mitchells-plain', 'Colorado, Mitchells Plain', -34.027000, 18.592000, 'town', 'Q108660786'),
  ('constantia', 'Constantia', -34.031389, 18.418333, 'town', 'Q1127739'),
  ('constantia-park', 'Constantia Park', -25.802200, 28.286900, 'town', 'Q3093449'),
  ('cradock', 'Cradock', -32.165000, 25.617500, 'town', 'Q1138465'),
  ('cradock-airport', 'Cradock Airport', -32.155555, 25.645833, 'airport', 'Q12692337'),
  ('crawford', 'Crawford', -33.979500, 18.506800, 'town', 'Q4831563'),
  ('crossroads', 'Crossroads', -33.983333, 18.583333, 'town', 'Q5188787'),
  ('da-gama-park', 'Da Gama Park', -34.161000, 18.403000, 'town', 'Q15212442'),
  ('darling', 'Darling', -33.383333, 18.383333, 'town', 'Q1003369'),
  ('de-aar', 'De Aar', -30.650000, 24.016667, 'town', 'Q743069'),
  ('de-aar-airport', 'De Aar Airport', -30.691530, 24.024203, 'airport', 'Q12692401'),
  ('de-oude-weg', 'De Oude Weg', -34.137028, 18.375333, 'town', 'Q113511438'),
  ('de-waterkant', 'De Waterkant', -33.915278, 18.418889, 'town', 'Q3020285'),
  ('delareyville-airport', 'Delareyville Airport', -26.683333, 25.466667, 'airport', 'Q12692419'),
  ('delmas', 'Delmas', -26.133333, 28.666667, 'airport', 'Q31910228'),
  ('diep-river-cape-town', 'Diep River, Cape Town', -34.034200, 18.464400, 'town', 'Q5274960'),
  ('dordrecht', 'Dordrecht', -31.383333, 27.033333, 'airport', 'Q31911765'),
  ('dukuduku-airport', 'Dukuduku Airport', -28.368417, 32.248138, 'airport', 'Q12692491'),
  ('dundee', 'Dundee', -28.166667, 30.233611, 'town', 'Q1265538'),
  ('dundee-airport', 'Dundee Airport', -28.189167, 30.219552, 'airport', 'Q12692496'),
  ('dunnottar', 'Dunnottar', -26.350000, 28.466667, 'airport', 'Q31912602'),
  ('durban', 'Durban', -29.858333, 31.025000, 'city', 'Q5468'),
  ('durban-international-airport', 'Durban International Airport', -29.968611, 30.947778, 'airport', 'Q1266839'),
  ('durban-marina', 'Durban Marina', -29.862778, 31.021667, 'port', 'Q138824379'),
  ('durbanville', 'Durbanville', -33.816667, 18.850000, 'town', 'Q3041548'),
  ('dwaalboom-airport', 'Dwaalboom Airport', -24.803957, 26.833315, 'airport', 'Q12692503'),
  ('dysselsdorp', 'Dysselsdorp', -33.566700, 22.433300, 'town', 'Q1992773'),
  ('east-london', 'East London', -33.017500, 27.904722, 'city', 'Q209537'),
  ('east-london-airport', 'East London Airport', -33.035000, 27.821667, 'airport', 'Q3496971'),
  ('eastridge-mitchells-plain', 'Eastridge, Mitchells Plain', -34.050000, 18.627000, 'town', 'Q108559165'),
  ('edenburg', 'Edenburg', -29.733333, 25.900000, 'airport', 'Q31913093'),
  ('edgemead', 'Edgemead', -33.875556, 18.540833, 'town', 'Q4853791'),
  ('eerste-rivier', 'Eerste Rivier', -34.083333, 18.766667, 'town', 'Q4854168'),
  ('empangeni', 'Empangeni', -28.750000, 31.900000, 'town', 'Q1339143'),
  ('epping', 'Epping', -33.934200, 18.543600, 'town', 'Q5383864'),
  ('ermelo', 'Ermelo', -26.533333, 29.983333, 'town', 'Q1027521'),
  ('eshowe-airport', 'Eshowe Airport', -28.906175, 31.446267, 'airport', 'Q12692599'),
  ('estcourt', 'Estcourt', -29.000000, 29.883333, 'town', 'Q985827'),
  ('estcourt-airport', 'Estcourt Airport', -29.047342, 29.910642, 'airport', 'Q12692611'),
  ('faure', 'Faure', -34.031000, 18.753000, 'town', 'Q15217489'),
  ('ficksburg-sentraoes-airport', 'Ficksburg Sentraoes Airport', -28.823118, 27.908900, 'airport', 'Q12692701'),
  ('fisantekraal-airfield', 'Fisantekraal Airfield', -33.768950, 18.741800, 'airport', 'Q5454370'),
  ('fish-hoek', 'Fish Hoek', -34.136000, 18.430000, 'town', 'Q913974'),
  ('fordsburg', 'Fordsburg', -26.206667, 28.023333, 'town', 'Q619523'),
  ('foreshore', 'Foreshore', -33.920000, 18.430000, 'town', 'Q15218008'),
  ('fort-beaufort-airport', 'Fort Beaufort Airport', -32.783333, 26.583333, 'airport', 'Q20459376'),
  ('frankfort', 'Frankfort', -27.278880, 28.496960, 'town', 'Q31916410'),
  ('fraserburg', 'Fraserburg', -31.914444, 21.511944, 'town', 'Q2609896'),
  ('fresnaye', 'Fresnaye', -33.925000, 18.387500, 'town', 'Q3087534'),
  ('ga-kgapane', 'Ga-Kgapane', -23.649000, 30.226000, 'town', 'Q5515188'),
  ('ga-mokobodi', 'Ga-Mokobodi', -23.517000, 28.983000, 'town', 'Q33143999'),
  ('ga-motlatla', 'Ga-Motlatla', -26.071970, 26.572190, 'town', 'Q120694366'),
  ('galeshewe', 'Galeshewe', -28.717000, 24.725000, 'town', 'Q5518488'),
  ('gardens', 'Gardens', -33.933333, 18.408333, 'town', 'Q3095436'),
  ('gariep-dam-airport', 'Gariep Dam Airport', -30.562192, 25.529913, 'airport', 'Q20460526'),
  ('genadendal', 'Genadendal', -34.033333, 19.550000, 'town', 'Q1501295'),
  ('george', 'George', -33.966700, 22.450000, 'city', 'Q370456'),
  ('george-airport', 'George Airport', -34.006667, 22.380833, 'airport', 'Q1431367'),
  ('gezina-pretoria', 'Gezina, Pretoria', -25.718056, 28.208889, 'town', 'Q3104727'),
  ('gifvlei-airport', 'Gifvlei Airport', -30.383333, 20.033333, 'airport', 'Q20461532'),
  ('giyani-airport', 'Giyani Airport', -23.283472, 30.649972, 'airport', 'Q12692838'),
  ('glencairn', 'Glencairn', -34.163300, 18.429700, 'town', 'Q5568221'),
  ('goodwood', 'Goodwood', -33.911300, 18.550600, 'town', 'Q5583705'),
  ('gordon-s-bay', 'Gordon''s Bay', -34.150000, 18.866667, 'town', 'Q2613726'),
  ('gouda-western-cape', 'Gouda, Western Cape', -33.300000, 19.033300, 'town', 'Q2624429'),
  ('gqeberha', 'Gqeberha', -33.958056, 25.600000, 'city', 'Q125434'),
  ('graaff-reinet-airport', 'Graaff Reinet Airport', -32.193612, 24.541388, 'airport', 'Q12692870'),
  ('graaff-reinet', 'Graaff-Reinet', -32.252222, 24.540556, 'town', 'Q1004667'),
  ('grahamstown-airport', 'Grahamstown Airport', -33.283333, 26.500000, 'airport', 'Q20462301'),
  ('grand-central-airport', 'Grand Central Airport', -25.986389, 28.140000, 'airport', 'Q3914596'),
  ('grassy-park', 'Grassy Park', -34.050000, 18.483333, 'town', 'Q4933775'),
  ('green-point', 'Green Point', -33.900000, 18.400000, 'town', 'Q2282472'),
  ('greytown', 'Greytown', -29.066667, 30.583333, 'town', 'Q1021891'),
  ('greytown-airport', 'Greytown Airport', -29.122012, 30.586707, 'airport', 'Q5608515'),
  ('groenkloof', 'Groenkloof', -25.775108, 28.217956, 'town', 'Q2566863'),
  ('groot-marico', 'Groot Marico', -25.588000, 26.401000, 'town', 'Q3642486'),
  ('h-m-s-bastard-memorial-airport', 'H.M.S.Bastard Memorial Airport', -30.546667, 29.504167, 'airport', 'Q20447377'),
  ('hanover-park', 'Hanover Park', -33.994000, 18.531000, 'town', 'Q15222957'),
  ('harding-airport', 'Harding Airport', -30.566667, 29.883333, 'airport', 'Q12692958'),
  ('harfield-village', 'Harfield Village', -33.986000, 18.476000, 'town', 'Q15223023'),
  ('harmony-airport', 'Harmony Airport', -28.078693, 26.861178, 'airport', 'Q20448157'),
  ('harrismith', 'Harrismith', -28.283333, 29.133333, 'town', 'Q1586262'),
  ('heathfield', 'Heathfield', -34.048600, 18.468600, 'town', 'Q10969186'),
  ('heidelberg', 'Heidelberg', -34.083333, 20.950000, 'town', 'Q1021918'),
  ('heidelberg-q1594009', 'Heidelberg', -26.500556, 28.358333, 'town', 'Q1594009'),
  ('heidelberg-q31499233', 'Heidelberg', -32.273333, 25.970000, 'town', 'Q31499233'),
  ('heidelberg-airport', 'Heidelberg Airport', -26.506278, 28.393917, 'airport', 'Q12692981'),
  ('heideveld', 'Heideveld', -33.966667, 18.550000, 'town', 'Q5698789'),
  ('heilbron-airport', 'Heilbron Airport', -27.283333, 27.983333, 'airport', 'Q12692982'),
  ('hendrik-swellengrebel-airport', 'Hendrik Swellengrebel airport', -34.050000, 20.483333, 'airport', 'Q12692987'),
  ('hendrik-van-eck-airport', 'Hendrik Van Eck Airport', -23.937167, 31.155390, 'airport', 'Q1028335'),
  ('hendrinakrag', 'Hendrinakrag', -26.016657, 29.593692, 'town', 'Q66545528'),
  ('hennenman', 'Hennenman', -28.016667, 27.066667, 'airport', 'Q31919706'),
  ('hermanus', 'Hermanus', -34.416667, 19.300000, 'town', 'Q1613480'),
  ('hesteapark', 'Hesteapark', -25.655833, 28.140278, 'town', 'Q112568177'),
  ('higgovale', 'Higgovale', -33.939400, 18.402500, 'town', 'Q3135348'),
  ('hillbrow', 'Hillbrow', -26.188889, 28.048889, 'town', 'Q3132723'),
  ('hluhluwe-airport', 'Hluhluwe Airport', -28.008333, 32.275000, 'airport', 'Q3274747'),
  ('hoedspruit-eastgate-airport', 'Hoedspruit Eastgate Airport', -24.384444, 31.046667, 'airport', 'Q125820197'),
  ('hoopstad-airport', 'Hoopstad Airport', -27.825000, 25.912500, 'airport', 'Q12693024'),
  ('hopefield', 'Hopefield', -33.066667, 18.350000, 'town', 'Q993081'),
  ('hout-bay', 'Hout Bay', -34.033333, 18.350000, 'town', 'Q1013375'),
  ('howick', 'Howick', -29.486078, 30.230597, 'town', 'Q1503458'),
  ('humansdorp', 'Humansdorp', -34.033333, 24.766667, 'town', 'Q2119634'),
  ('idutywa-airport', 'Idutywa Airport', -32.100000, 28.316667, 'airport', 'Q20451237'),
  ('irene', 'Irene', -25.866667, 28.216667, 'town', 'Q3644425'),
  ('jack-duvenhage-airport', 'Jack Duvenhage Airport', -27.941465, 22.738267, 'airport', 'Q12693156'),
  ('jamestown', 'Jamestown', -33.979000, 18.848000, 'town', 'Q6146167'),
  ('jeffreys-bay', 'Jeffreys Bay', -34.033333, 24.916667, 'town', 'Q585092'),
  ('joe-slovo', 'Joe Slovo', -33.951944, 18.534167, 'town', 'Q15229624'),
  ('johan-pienaar-airport', 'Johan Pienaar Airport', -27.456667, 23.411389, 'airport', 'Q1580098'),
  ('johannesburg', 'Johannesburg', -26.204361, 28.041639, 'city', 'Q34647'),
  ('johannesburg-cbd', 'Johannesburg CBD', -26.200000, 28.033333, 'town', 'Q6217146'),
  ('kalk-bay', 'Kalk Bay', -34.127778, 18.448333, 'town', 'Q600605'),
  ('katlehong', 'Katlehong', -26.333333, 28.150000, 'city', 'Q2612280'),
  ('kenhardt-airport', 'Kenhardt Airport', -29.344562, 21.200000, 'airport', 'Q12693325'),
  ('kenwyn', 'Kenwyn', -33.998889, 18.508611, 'town', 'Q6392532'),
  ('kewtown', 'Kewtown', -33.959906, 18.516186, 'town', 'Q99522187'),
  ('kimberley', 'Kimberley', -28.738333, 24.763889, 'city', 'Q125905'),
  ('kimberley-airport', 'Kimberley Airport', -28.801667, 24.763611, 'airport', 'Q1141523'),
  ('king-shaka-international-airport', 'King Shaka International Airport', -29.614444, 31.116389, 'airport', 'Q392728'),
  ('kitty-hawk-aero-estate-airport', 'Kitty Hawk Aero Estate Airport', -25.860827, 28.451612, 'airport', 'Q20466197'),
  ('klapmuts', 'Klapmuts', -33.805600, 18.869700, 'town', 'Q2788523'),
  ('klawer', 'Klawer', -31.783333, 18.616667, 'town', 'Q993103'),
  ('kleinmond', 'Kleinmond', -34.350000, 19.033333, 'town', 'Q187320'),
  ('kleinzee-airport', 'Kleinzee Airport', -29.683333, 17.093333, 'airport', 'Q10853711'),
  ('klerksdorp', 'Klerksdorp', -26.866667, 26.666667, 'town', 'Q1015647'),
  ('kloofsig', 'Kloofsig', -25.813100, 28.205000, 'town', 'Q3211098'),
  ('knysna', 'Knysna', -34.035556, 23.048889, 'town', 'Q251137'),
  ('kobus-de-villiers-airport', 'Kobus De Villiers Airport', -25.186767, 29.403292, 'airport', 'Q12693397'),
  ('kokstad', 'Kokstad', -30.553889, 29.426944, 'town', 'Q1671256'),
  ('komati-power-station-airport', 'Komati Power Station Airport', -26.093583, 29.455083, 'airport', 'Q20466542'),
  ('komatipoort', 'Komatipoort', -25.433333, 31.950000, 'town', 'Q1779827'),
  ('komatipoort-airport', 'Komatipoort Airport', -25.433333, 31.933333, 'airport', 'Q20466544'),
  ('kommetjie', 'Kommetjie', -34.140278, 18.329167, 'town', 'Q1003382'),
  ('kraaifontein', 'Kraaifontein', -33.844167, 18.698611, 'town', 'Q5200520'),
  ('kriel-airport', 'Kriel Airport', -26.251888, 29.194557, 'airport', 'Q12693432'),
  ('kroonstad', 'Kroonstad', -27.645556, 27.231667, 'town', 'Q264014'),
  ('kroonstad-airport', 'Kroonstad Airport', -27.666667, 27.316667, 'airport', 'Q6439004'),
  ('kruger-mpumalanga-international-airport', 'Kruger Mpumalanga International Airport', -25.383333, 31.105556, 'airport', 'Q1431784'),
  ('kruisrivier', 'Kruisrivier', -33.600000, 21.983333, 'town', 'Q99522233'),
  ('kuils-river-town', 'Kuils River (town)', -34.033333, 18.700000, 'town', 'Q3643167'),
  ('kuruman', 'Kuruman', -27.459722, 23.412500, 'town', 'Q1025965'),
  ('kwaguqa', 'KwaGuqa', -25.863889, 29.118889, 'town', 'Q12731752'),
  ('ladybrand-airport', 'Ladybrand Airport', -29.166667, 27.450000, 'airport', 'Q12693513'),
  ('ladysmith', 'Ladysmith', -28.553889, 29.782500, 'town', 'Q874262'),
  ('ladysmith-airport', 'Ladysmith Airport', -28.580000, 29.753333, 'airport', 'Q8214433'),
  ('laingsburg', 'Laingsburg', -33.195000, 20.859167, 'town', 'Q927822'),
  ('lambert-s-bay', 'Lambert''s Bay', -32.083333, 18.300000, 'town', 'Q225041'),
  ('lansdowne', 'Lansdowne', -33.985800, 18.500300, 'town', 'Q6487354'),
  ('lanseria-international-airport', 'Lanseria International Airport', -25.938611, 27.926111, 'airport', 'Q2163819'),
  ('leandra', 'Leandra', -26.373611, 28.920000, 'town', 'Q6509556'),
  ('leeupoort', 'Leeupoort', -24.911944, 27.639444, 'town', 'Q137777690'),
  ('lentegeur', 'Lentegeur', -34.030000, 18.618000, 'town', 'Q108619532'),
  ('lichtenburg', 'Lichtenburg', -26.150000, 26.166667, 'town', 'Q2671213'),
  ('llandudno', 'Llandudno', -34.000000, 18.333333, 'town', 'Q456564'),
  ('logi-kuasa-majuba-airport', 'Logi Kuasa Majuba Airport', -27.083055, 29.785000, 'airport', 'Q12693643'),
  ('lotus-river-cape-town', 'Lotus River, Cape Town', -34.035556, 18.516389, 'town', 'Q18127521'),
  ('lusikisiki-airport', 'Lusikisiki Airport', -31.366667, 29.583333, 'airport', 'Q12693700'),
  ('lydenburg-airport', 'Lydenburg Airport', -25.103395, 30.414203, 'airport', 'Q20453547'),
  ('macassar', 'Macassar', -34.066667, 18.766667, 'town', 'Q1590213'),
  ('machadodorp', 'Machadodorp', -25.666667, 30.250000, 'town', 'Q3070774'),
  ('mafikeng-airport', 'Mafikeng Airport', -25.807500, 25.544444, 'airport', 'Q1027520'),
  ('mafikeng-north-airport', 'Mafikeng North Airport', -25.752857, 25.611990, 'airport', 'Q20453988'),
  ('mahikeng', 'Mahikeng', -25.865278, 25.644167, 'town', 'Q211055'),
  ('maitland', 'Maitland', -33.924722, 18.486944, 'town', 'Q3280389'),
  ('makhanda', 'Makhanda', -33.300000, 26.533333, 'town', 'Q951161'),
  ('mala-mala-airport', 'Mala Mala Airport', -24.818056, 31.544722, 'airport', 'Q2875865'),
  ('malelane', 'Malelane', -25.563300, 31.486700, 'town', 'Q31476643'),
  ('malelane-airport', 'Malelane Airport', -25.473603, 31.565828, 'airport', 'Q12693773'),
  ('malmesbury', 'Malmesbury', -33.450000, 18.733333, 'town', 'Q3113320'),
  ('malmesbury-airport', 'Malmesbury Airport', -33.466667, 18.700000, 'airport', 'Q20455266'),
  ('mamre', 'Mamre', -33.516700, 18.466700, 'town', 'Q11142530'),
  ('mandalay-mitchells-plain', 'Mandalay, Mitchells Plain', -34.016300, 18.626000, 'town', 'Q108649523'),
  ('mandela-park', 'Mandela Park', -34.049000, 18.686000, 'town', 'Q110643874'),
  ('manenberg', 'Manenberg', -33.983333, 18.550000, 'town', 'Q6588027'),
  ('marble-hall-airport', 'Marble Hall Airport', -24.991667, 29.283333, 'airport', 'Q12693819'),
  ('margate-airport', 'Margate Airport', -30.857670, 30.346215, 'airport', 'Q1031474'),
  ('matatiele', 'Matatiele', -30.342222, 28.806111, 'town', 'Q638513'),
  ('mbombela', 'Mbombela', -25.465833, 30.985278, 'town', 'Q170313'),
  ('meadowridge', 'Meadowridge', -34.033333, 18.450000, 'town', 'Q15252589'),
  ('melkbosstrand', 'Melkbosstrand', -33.733333, 18.433333, 'town', 'Q3642280'),
  ('melville', 'Melville', -26.175833, 28.008889, 'town', 'Q6813840'),
  ('memel', 'Memel', -27.683333, 29.566667, 'town', 'Q1708628'),
  ('messina-airport', 'Messina Airport', -22.356057, 29.986583, 'airport', 'Q20450364'),
  ('middelburg', 'Middelburg', -31.493889, 25.017222, 'town', 'Q1002188'),
  ('middelburg-q1931836', 'Middelburg', -25.768056, 29.454722, 'town', 'Q1931836'),
  ('middelburg-q31954983', 'Middelburg', -25.684770, 29.440160, 'town', 'Q31954983'),
  ('middelburg-airport', 'Middelburg Airport', -31.516667, 25.033333, 'airport', 'Q20450619'),
  ('midstream', 'Midstream', -25.918490, 28.198810, 'town', 'Q31955273'),
  ('milnerton', 'Milnerton', -33.866667, 18.500000, 'town', 'Q3642516'),
  ('mitchells-plain', 'Mitchells Plain', -34.050556, 18.618056, 'town', 'Q3078599'),
  ('mkuze-airport', 'Mkuze Airport', -27.624759, 32.043972, 'airport', 'Q123469971'),
  ('mkuzi-airport', 'Mkuzi Airport', -27.633333, 32.050000, 'airport', 'Q12693978'),
  ('mokopane', 'Mokopane', -24.183333, 29.016667, 'town', 'Q326927'),
  ('montagu', 'Montagu', -33.783333, 20.116667, 'town', 'Q1800611'),
  ('monte-vista', 'Monte Vista', -33.866667, 18.550000, 'town', 'Q6904940'),
  ('mooi-river', 'Mooi River', -26.874400, 26.951700, 'town', 'Q879899'),
  ('mooi-river-q1946653', 'Mooi River', -29.200000, 29.983300, 'town', 'Q1946653'),
  ('mooi-river-q4788111', 'Mooi River', -28.762778, 30.568611, 'town', 'Q4788111'),
  ('moorreesburg', 'Moorreesburg', -33.150000, 18.666667, 'town', 'Q1003332'),
  ('morningside', 'Morningside', -26.078200, 28.062500, 'town', 'Q6912963'),
  ('moruleng', 'Moruleng', -25.179000, 27.194000, 'town', 'Q6915074'),
  ('mossel-bay', 'Mossel Bay', -34.183333, 22.133333, 'town', 'Q995615'),
  ('mossel-bay-airport', 'Mossel Bay Airport', -34.160940, 22.055408, 'airport', 'Q20452885'),
  ('mouille-point', 'Mouille Point', -33.900833, 18.405556, 'town', 'Q763449'),
  ('mountain-view', 'Mountain View', -26.168000, 28.082000, 'town', 'Q950305'),
  ('mowbray', 'Mowbray', -33.946111, 18.476111, 'town', 'Q6927241'),
  ('mpumalanga', 'Mpumalanga', -29.812778, 30.636389, 'city', 'Q1005268'),
  ('mthatha', 'Mthatha', -31.588611, 28.790000, 'town', 'Q1020914'),
  ('mthatha-airport', 'Mthatha Airport', -31.546389, 28.675278, 'airport', 'Q8214380'),
  ('mtubatuba', 'Mtubatuba', -28.416667, 32.183333, 'town', 'Q1013531'),
  ('muizenberg', 'Muizenberg', -34.105556, 18.468056, 'town', 'Q116448'),
  ('musina', 'Musina', -22.338056, 30.041667, 'town', 'Q1025661'),
  ('mvezo', 'Mvezo', -31.950000, 28.516000, 'town', 'Q1020378'),
  ('naval-station-durban', 'Naval Station Durban', -29.882632, 31.039566, 'port', 'Q18379711'),
  ('ndabeni', 'Ndabeni', -33.929444, 18.492222, 'town', 'Q6983658'),
  ('nelspruit-airport', 'Nelspruit Airport', -25.500000, 30.913800, 'airport', 'Q3643204'),
  ('new-tempe-airport', 'New Tempe Airport', -29.031389, 26.159444, 'airport', 'Q12694164'),
  ('newcastle', 'Newcastle', -27.746389, 29.932778, 'town', 'Q1027294'),
  ('newlands', 'Newlands', -33.979167, 18.450000, 'town', 'Q636253'),
  ('newmarket-park', 'Newmarket Park', -26.283889, 28.129167, 'town', 'Q61355560'),
  ('ninapark', 'Ninapark', -25.683333, 28.150000, 'town', 'Q112568085'),
  ('noordhoek', 'Noordhoek', -34.104000, 18.360000, 'town', 'Q378376'),
  ('northern-suburbs-cape-town', 'Northern Suburbs, Cape Town', -33.900000, 18.633333, 'town', 'Q97355854'),
  ('northmead', 'Northmead', -26.160000, 28.313889, 'town', 'Q55638350'),
  ('norwood', 'Norwood', -33.933333, 18.566667, 'town', 'Q7061595'),
  ('numbi', 'Numbi', -25.434722, 31.198611, 'town', 'Q33037240'),
  ('nyanga', 'Nyanga', -33.983333, 18.583333, 'town', 'Q7019937'),
  ('nylstroom-airport', 'Nylstroom Airport', -24.685538, 28.428155, 'airport', 'Q12694225'),
  ('observatory', 'Observatory', -33.937800, 18.470800, 'town', 'Q3025268'),
  ('ocean-view', 'Ocean View', -34.153300, 18.355300, 'town', 'Q3348676'),
  ('onrusrivier', 'Onrusrivier', -34.412200, 19.170000, 'town', 'Q2375906'),
  ('or-tambo-international-airport', 'OR Tambo International Airport', -26.139167, 28.246111, 'airport', 'Q821750'),
  ('orania', 'Orania', -29.816667, 24.400000, 'town', 'Q1011020'),
  ('oranjezicht', 'Oranjezicht', -33.941667, 18.413889, 'town', 'Q3355106'),
  ('ottery', 'Ottery', -34.014700, 18.504400, 'town', 'Q7109462'),
  ('oudtshoorn', 'Oudtshoorn', -33.583333, 22.200000, 'town', 'Q951049'),
  ('oudtshoorn-airport', 'Oudtshoorn airport', -33.600755, 22.189282, 'airport', 'Q20460330'),
  ('p-r-mphephu-airport', 'P.R.Mphephu Airport', -23.076900, 30.383600, 'airport', 'Q12694316'),
  ('paarl', 'Paarl', -33.724167, 18.955833, 'town', 'Q1018144'),
  ('palmietfontein-airport', 'Palmietfontein Airport', -26.336667, 28.146667, 'airport', 'Q7128392'),
  ('panorama-cape-town', 'Panorama, Cape Town', -33.880000, 18.576100, 'town', 'Q3362390'),
  ('parklands', 'Parklands', -33.814444, 18.502500, 'town', 'Q7138578'),
  ('parys-airport', 'Parys Airport', -26.887205, 27.505308, 'airport', 'Q12694363'),
  ('phalaborwa', 'Phalaborwa', -23.933333, 31.116667, 'town', 'Q1896233'),
  ('pierre-van-ryneveld-park', 'Pierre van Ryneveld Park', -25.841400, 28.243600, 'town', 'Q3211104'),
  ('piet-retief', 'Piet Retief', -27.000000, 30.800000, 'town', 'Q1395427'),
  ('piet-retief-airport', 'Piet Retief Airport', -27.002222, 30.843888, 'airport', 'Q12694431'),
  ('pietermaritzburg', 'Pietermaritzburg', -29.600900, 30.379600, 'town', 'Q185591'),
  ('pietermaritzburg-airport', 'Pietermaritzburg Airport', -29.646667, 30.398333, 'airport', 'Q764703'),
  ('pietersburg-airport', 'Pietersburg Airport', -23.916667, 29.483333, 'airport', 'Q12694428'),
  ('piketberg', 'Piketberg', -32.900000, 18.766667, 'town', 'Q2006534'),
  ('pilanesberg-international-airport', 'Pilanesberg International Airport', -25.333611, 27.173333, 'airport', 'Q2233125'),
  ('pinelands', 'Pinelands', -33.931667, 18.512778, 'town', 'Q7195518'),
  ('pinetown', 'Pinetown', -29.816667, 30.850000, 'town', 'Q985839'),
  ('plettenberg-bay', 'Plettenberg Bay', -34.050000, 23.366667, 'town', 'Q922360'),
  ('plumstead', 'Plumstead', -34.022222, 18.472222, 'town', 'Q3392656'),
  ('pofadder-airport', 'Pofadder Airport', -29.141667, 19.413055, 'airport', 'Q12694466'),
  ('polokwane', 'Polokwane', -23.900000, 29.450000, 'town', 'Q131662'),
  ('polokwane-ext-44', 'Polokwane Ext 44', -23.891400, 29.416500, 'town', 'Q116813782'),
  ('polokwane-international-airport', 'Polokwane International Airport', -23.845278, 29.458611, 'airport', 'Q2233103'),
  ('pomfret-airport', 'Pomfret Airport', -25.847167, 23.537862, 'airport', 'Q12694470'),
  ('pongola-airport', 'Pongola Airport', -27.361667, 31.605556, 'airport', 'Q12694476'),
  ('port-alfred-airport', 'Port Alfred Airport', -33.554167, 26.879722, 'airport', 'Q7230476'),
  ('port-of-cape-town', 'Port of Cape Town', -33.904444, 18.420278, 'port', 'Q12066211'),
  ('port-of-durban', 'Port of Durban', -29.873660, 31.023230, 'port', 'Q7231133'),
  ('port-of-ngqura', 'Port of Ngqura', -33.800733, 25.683767, 'port', 'Q7231217'),
  ('port-of-richards-bay', 'Port of Richards Bay', -28.785000, 32.047222, 'port', 'Q138839485'),
  ('port-of-saldanha', 'Port of Saldanha', -33.023056, 17.954406, 'port', 'Q15818981'),
  ('port-shepstone', 'Port Shepstone', -30.741111, 30.454722, 'town', 'Q121395'),
  ('port-st-johns-airport', 'Port St Johns Airport', -31.608120, 29.517870, 'airport', 'Q123470063'),
  ('porterville', 'Porterville', -33.000000, 18.983333, 'town', 'Q1003379'),
  ('portland-mitchells-plain', 'Portland, Mitchells Plain', -34.051000, 18.613000, 'town', 'Q108581914'),
  ('postmasburg-airport', 'Postmasburg Airport', -28.333333, 23.083333, 'airport', 'Q20459565'),
  ('potchefstroom', 'Potchefstroom', -26.715000, 27.103333, 'town', 'Q605167'),
  ('potchefstroom-airport', 'Potchefstroom Airport', -26.670556, 27.081667, 'airport', 'Q20459606'),
  ('potgietersrus', 'Potgietersrus', -24.229254, 28.985237, 'airport', 'Q31999411'),
  ('pretoria', 'Pretoria', -25.746389, 28.188056, 'city', 'Q3926'),
  ('prieska-airport', 'Prieska Airport', -29.683705, 22.770603, 'airport', 'Q12694525'),
  ('prince-albert-airport', 'Prince Albert Airport', -33.200000, 22.033333, 'airport', 'Q12694530'),
  ('prince-m-buthelezi-airport', 'Prince M. Buthelezi Airport', -28.318870, 31.416115, 'airport', 'Q12694532'),
  ('queenstown-airport', 'Queenstown Airport', -31.917380, 26.879700, 'airport', 'Q123470117'),
  ('queenswood', 'Queenswood', -25.733333, 28.250000, 'town', 'Q25614068'),
  ('rand-airport', 'Rand Airport', -26.242500, 28.151111, 'airport', 'Q3270757'),
  ('randburg', 'Randburg', -26.093611, 28.006389, 'city', 'Q2296366'),
  ('rawsonville', 'Rawsonville', -33.684694, 19.315000, 'town', 'Q2319575'),
  ('reebok', 'Reebok', -34.075000, 22.175000, 'town', 'Q96802654'),
  ('reitz-airport', 'Reitz Airport', -27.783333, 28.450000, 'airport', 'Q20449718'),
  ('reivilo-airport', 'Reivilo Airport', -27.554167, 24.166667, 'airport', 'Q20449725'),
  ('richards-bay', 'Richards Bay', -28.782778, 32.037500, 'town', 'Q1471757'),
  ('richards-bay-airport', 'Richards Bay Airport', -28.740833, 32.091944, 'airport', 'Q7330281'),
  ('richards-bay-coal-terminal', 'Richards Bay Coal Terminal', -28.820853, 32.056514, 'port', 'Q691664'),
  ('richards-bay-marina', 'Richards Bay marina', -28.788056, 32.081944, 'port', 'Q138840764'),
  ('richmond', 'Richmond', -29.866667, 30.266667, 'town', 'Q985819'),
  ('richmond-q7330730', 'Richmond', -31.413300, 23.946700, 'town', 'Q7330730'),
  ('richwood', 'Richwood', -33.832000, 18.544000, 'town', 'Q28359615'),
  ('rietkuil', 'Rietkuil', -25.946201, 29.805861, 'town', 'Q66494304'),
  ('riversdale', 'Riversdale', -34.096944, 21.262222, 'town', 'Q2120963'),
  ('riviersonderend', 'Riviersonderend', -34.150000, 19.900000, 'town', 'Q667534'),
  ('rivonia', 'Rivonia', -26.051400, 28.063100, 'town', 'Q614689'),
  ('robertson', 'Robertson', -33.800000, 19.883333, 'town', 'Q2096823'),
  ('robertson-airfield', 'Robertson Airfield', -33.811775, 19.903697, 'airport', 'Q7352086'),
  ('robinson-lake-aerodrome', 'Robinson Lake Aerodrome', -26.150000, 27.700000, 'airport', 'Q32008196'),
  ('rocklands-mitchells-plain', 'Rocklands, Mitchells Plain', -34.064000, 18.609000, 'town', 'Q108570123'),
  ('rondebosch', 'Rondebosch', -33.963333, 18.476389, 'town', 'Q3073398'),
  ('rondebosch-east', 'Rondebosch East', -33.979200, 18.498300, 'town', 'Q7365538'),
  ('roodepoort', 'Roodepoort', -26.162500, 27.872500, 'city', 'Q2166182'),
  ('rorke-s-drift', 'Rorke''s Drift', -28.359167, 30.536111, 'town', 'Q2166343'),
  ('rosebank', 'Rosebank', -33.955556, 18.474167, 'town', 'Q7368057'),
  ('rosettenville', 'Rosettenville', -26.251389, 28.055278, 'town', 'Q3644552'),
  ('rustenburg', 'Rustenburg', -25.666667, 27.233611, 'town', 'Q182049'),
  ('rustenburg-airfield', 'Rustenburg Airfield', -25.644300, 27.271119, 'airport', 'Q6151254'),
  ('sace-airport', 'Sace Airport', -25.955555, 29.211112, 'airport', 'Q20452928'),
  ('saldanha', 'Saldanha', -32.997778, 17.945556, 'town', 'Q1643816'),
  ('saldanha-bay', 'Saldanha Bay', -33.034722, 18.009722, 'town', 'Q1563436'),
  ('saldanha-vredenburg-airport', 'Saldanha-Vredenburg Airport', -32.964100, 17.969300, 'airport', 'Q20453545'),
  ('salt-river', 'Salt River', -33.932778, 18.457500, 'town', 'Q2383969'),
  ('sandton', 'Sandton', -26.107000, 28.051667, 'city', 'Q1026420'),
  ('saron', 'Saron', -33.181000, 19.010000, 'town', 'Q3642609'),
  ('scarborough', 'Scarborough', -34.198333, 18.375556, 'town', 'Q7430257'),
  ('schotsche-kloof', 'Schotsche Kloof', -33.920300, 18.410800, 'town', 'Q3475517'),
  ('schweizer-reneke-airport', 'Schweizer Reneke Airport', -27.166667, 25.300000, 'airport', 'Q20455844'),
  ('sea-point', 'Sea Point', -33.915278, 18.392500, 'town', 'Q2383557'),
  ('secunda', 'Secunda', -26.550000, 29.166667, 'town', 'Q2110377'),
  ('secunda-airport', 'Secunda Airport', -26.520555, 29.172222, 'airport', 'Q20456109'),
  ('silvertown', 'Silvertown', -33.963650, 18.530100, 'town', 'Q99521942'),
  ('sir-lowry-s-pass-village', 'Sir Lowry''s Pass Village', -34.116667, 18.913056, 'town', 'Q7528274'),
  ('skierlik', 'Skierlik', -25.630800, 26.967200, 'town', 'Q125463548'),
  ('skukuza-airport', 'Skukuza Airport', -24.960833, 31.588611, 'airport', 'Q15278121'),
  ('somerset-east-airport', 'Somerset East Airport', -32.750000, 25.608333, 'airport', 'Q20464428'),
  ('somerset-west', 'Somerset West', -34.097222, 18.863889, 'town', 'Q1290313'),
  ('somersveld-airport', 'Somersveld Airport', -33.248057, 18.482778, 'airport', 'Q20464434'),
  ('sophiatown', 'Sophiatown', -26.176700, 27.981600, 'town', 'Q1517405'),
  ('southern-suburbs', 'Southern Suburbs', -33.983333, 18.475000, 'town', 'Q7570520'),
  ('southfield', 'Southfield', -34.033611, 18.485833, 'town', 'Q57387280'),
  ('soweto', 'Soweto', -26.267778, 27.858611, 'city', 'Q217426'),
  ('springbok', 'Springbok', -29.666667, 17.883333, 'town', 'Q2301363'),
  ('springbok-airport', 'Springbok Airport', -29.689330, 17.939610, 'airport', 'Q11824756'),
  ('springfield', 'Springfield', -26.228000, 28.049000, 'town', 'Q7580893'),
  ('springs-airport', 'Springs Airport', -26.250000, 28.400000, 'airport', 'Q12695092'),
  ('st-helena-bay', 'St Helena Bay', -32.758333, 18.027778, 'town', 'Q2656096'),
  ('st-james', 'St James', -34.118900, 18.459200, 'town', 'Q3495331'),
  ('stamford-hill-aerodrome', 'Stamford Hill Aerodrome', -29.827778, 31.033333, 'airport', 'Q131127047'),
  ('standerton', 'Standerton', -26.950000, 29.250000, 'town', 'Q742514'),
  ('standerton-airport', 'Standerton Airport', -26.933333, 29.183333, 'airport', 'Q20465395'),
  ('stanford-western-cape', 'Stanford, Western Cape', -34.441700, 19.455600, 'town', 'Q2742675'),
  ('steenberg', 'Steenberg', -34.066667, 18.466667, 'town', 'Q7605878'),
  ('stellenbosch', 'Stellenbosch', -33.936667, 18.861389, 'town', 'Q5460'),
  ('stellenbosch-q31686608', 'Stellenbosch', -24.271700, 30.112500, 'town', 'Q31686608'),
  ('steytlerville', 'Steytlerville', -33.332778, 24.344722, 'town', 'Q1003376'),
  ('strand', 'Strand', -34.116667, 18.816667, 'town', 'Q2407668'),
  ('suurbraak', 'Suurbraak', -34.004917, 20.652750, 'town', 'Q540535'),
  ('swellendam', 'Swellendam', -34.023056, 20.440000, 'town', 'Q1023257'),
  ('syferfontein-airport', 'Syferfontein Airport', -26.353313, 27.784155, 'airport', 'Q20452213'),
  ('table-view', 'Table View', -33.816667, 18.483333, 'town', 'Q2630680'),
  ('tafelsig-mitchells-plain', 'Tafelsig, Mitchells Plain', -34.060000, 18.637000, 'town', 'Q108607400'),
  ('tamboerskloof', 'Tamboerskloof', -33.929167, 18.404167, 'town', 'Q3073402'),
  ('taung', 'Taung', -27.562500, 24.748056, 'town', 'Q2096879'),
  ('thembisa', 'Thembisa', -26.005500, 28.210200, 'city', 'Q1580709'),
  ('thohoyandou', 'Thohoyandou', -22.950000, 30.483333, 'town', 'Q1025654'),
  ('thornton', 'Thornton', -33.923600, 18.535300, 'town', 'Q7796483'),
  ('three-anchor-bay', 'Three Anchor Bay', -33.908333, 18.395833, 'town', 'Q13034649'),
  ('tokai', 'Tokai', -34.062500, 18.441667, 'town', 'Q7813459'),
  ('tommy-airport', 'Tommy Airport', -28.266667, 23.000000, 'airport', 'Q20462522'),
  ('touws-river', 'Touws River', -33.316944, 20.031944, 'town', 'Q1003389'),
  ('touws-river-q7829437', 'Touws River', -33.736700, 21.181900, 'town', 'Q7829437'),
  ('trompsburg', 'Trompsburg', -30.016667, 25.766667, 'town', 'Q2426070'),
  ('tswalu-game-reserve-airport', 'Tswalu Game Reserve Airport', -27.225000, 22.477778, 'airport', 'Q20463118'),
  ('tulbagh', 'Tulbagh', -33.285000, 19.137778, 'town', 'Q1937242'),
  ('tutuka-power-station-airport', 'Tutuka Power Station Airport', -26.776557, 29.338778, 'airport', 'Q20463653'),
  ('tygerberg', 'Tygerberg', -33.854444, 18.584167, 'town', 'Q1408118'),
  ('tzaneen', 'Tzaneen', -23.833333, 30.166667, 'town', 'Q964666'),
  ('uitenhage', 'Uitenhage', -33.750000, 25.400000, 'town', 'Q1020192'),
  ('uitenhage-airport', 'Uitenhage Airport', -33.783333, 25.383333, 'airport', 'Q20463888'),
  ('ulundi', 'Ulundi', -28.335000, 31.416111, 'town', 'Q1013421'),
  ('university-estate', 'University Estate', -33.938889, 18.451389, 'town', 'Q3551340'),
  ('upington', 'Upington', -28.457222, 21.242500, 'town', 'Q575780'),
  ('upington-airport', 'Upington Airport', -28.401111, 21.259722, 'airport', 'Q1027555'),
  ('utrecht-airport', 'Utrecht Airport', -27.675982, 30.322592, 'airport', 'Q20464804'),
  ('van-reenen', 'Van Reenen', -28.376000, 29.381000, 'town', 'Q3643772'),
  ('vanderbijlpark', 'Vanderbijlpark', -26.699167, 27.835556, 'town', 'Q989955'),
  ('vanderbijlpark-airport', 'Vanderbijlpark Airport', -26.690647, 27.777255, 'airport', 'Q12695448'),
  ('vanrhynsdorp', 'Vanrhynsdorp', -31.616667, 18.716667, 'town', 'Q943414'),
  ('velddrif', 'Velddrif', -32.766667, 18.166667, 'town', 'Q993990'),
  ('venetia-airport', 'Venetia Airport', -22.448075, 29.337750, 'airport', 'Q12695465'),
  ('ventersdorp', 'Ventersdorp', -26.283333, 26.800000, 'airport', 'Q32039356'),
  ('vereeniging', 'Vereeniging', -26.673611, 27.931944, 'town', 'Q503056'),
  ('victoria-west-airport', 'Victoria West Airport', -31.400000, 23.150000, 'airport', 'Q12695479'),
  ('villieria', 'Villieria', -25.716667, 28.233333, 'town', 'Q19623823'),
  ('villiers', 'Villiers', -27.033333, 28.600000, 'town', 'Q3643597'),
  ('villiersdorp', 'Villiersdorp', -33.983333, 19.283333, 'town', 'Q1003349'),
  ('virginia-airport', 'Virginia Airport', -29.770556, 31.058333, 'airport', 'Q7934108'),
  ('volksrust', 'Volksrust', -27.366667, 29.883333, 'town', 'Q118638'),
  ('volksrust-airport', 'Volksrust Airport', -27.362127, 29.849747, 'airport', 'Q20465566'),
  ('vrede-airport', 'Vrede Airport', -27.438333, 29.156112, 'airport', 'Q12695512'),
  ('vredehoek', 'Vredehoek', -33.937500, 18.425000, 'town', 'Q3073400'),
  ('vredenburg', 'Vredenburg', -32.900000, 17.983333, 'town', 'Q2620432'),
  ('vredendal', 'Vredendal', -31.664444, 18.506111, 'town', 'Q1341350'),
  ('vryburg', 'Vryburg', -26.958611, 24.732222, 'town', 'Q1027291'),
  ('vryburg-airport', 'Vryburg Airport', -26.966667, 24.733333, 'airport', 'Q12695513'),
  ('vryheid', 'Vryheid', -27.769444, 30.791389, 'town', 'Q1023254'),
  ('wallacedene', 'Wallacedene', -33.858333, 18.733333, 'town', 'Q7962947'),
  ('walmer-estate', 'Walmer Estate', -33.936000, 18.445000, 'town', 'Q3565574'),
  ('warden', 'Warden', -27.850000, 28.966667, 'town', 'Q646845'),
  ('warmbaths-airport', 'Warmbaths Airport', -24.908055, 28.304445, 'airport', 'Q12695529'),
  ('waterkloof', 'Waterkloof', -25.766667, 28.233333, 'town', 'Q3643234'),
  ('wavecrest-airport', 'Wavecrest Airport', -32.583333, 28.516667, 'airport', 'Q12695544'),
  ('welkom', 'Welkom', -27.983056, 26.720833, 'town', 'Q1015631'),
  ('wesselsbron-airport', 'Wesselsbron Airport', -27.849872, 26.371350, 'airport', 'Q12695556'),
  ('westgate-mitchells-plain', 'Westgate, Mitchells Plain', -34.048000, 18.588000, 'town', 'Q108597500'),
  ('westridge', 'Westridge', -34.050000, 18.601000, 'town', 'Q108672933'),
  ('willowmore-north', 'Willowmore North', -33.050000, 23.416667, 'airport', 'Q32042379'),
  ('wilson-s-wharf', 'Wilson''s Wharf', -29.866667, 31.015556, 'port', 'Q138840016'),
  ('winburg', 'Winburg', -28.533333, 27.016667, 'town', 'Q238991'),
  ('witbank-airport', 'Witbank Airport', -25.832293, 29.192018, 'airport', 'Q12695590'),
  ('wolseley-western-cape', 'Wolseley, Western Cape', -33.413100, 19.201700, 'town', 'Q2312386'),
  ('wonderboom-airport', 'Wonderboom Airport', -25.653611, 28.224167, 'airport', 'Q3644152'),
  ('woodhill-estate-and-country-club', 'Woodhill Estate and Country Club', -25.820589, 28.312702, 'town', 'Q125499247'),
  ('woodlands-mitchells-plain', 'Woodlands, Mitchells Plain', -34.036000, 18.598000, 'town', 'Q108684928'),
  ('woodstock', 'Woodstock', -33.930556, 18.447222, 'town', 'Q15976093'),
  ('worcester', 'Worcester', -33.645000, 19.443611, 'town', 'Q1025649'),
  ('worcester-q15975747', 'Worcester', -24.317000, 30.555000, 'town', 'Q15975747'),
  ('wynberg', 'Wynberg', -34.004167, 18.470278, 'town', 'Q667463'),
  ('zastron', 'Zastron', -30.300000, 27.083333, 'town', 'Q148289'),
  ('zeerust-airport', 'Zeerust Airport', -25.600000, 26.033333, 'airport', 'Q12695660'),
  ('zonnebloem', 'Zonnebloem', -33.931111, 18.431944, 'town', 'Q3575986')
on conflict (slug) do nothing;

-- ============================================================
-- 0004_shipments.sql
-- ============================================================
-- 0004_shipments.sql — the thing being overseen.
--
-- Two tables. `shipments` is the unit of oversight; `checkpoints` is the
-- ordered journey, and it is what makes the route view possible.
--
-- THE JOURNEY IS A LIST OF EVENT ROWS, NOT A SET OF COLUMNS. A schema with
-- `collected_at`, `departed_at`, `arrived_at` columns looks simpler and cannot
-- express a load that passes through four depots, or a scan that happens
-- twice, or a border post that does not exist yet. Adding a stage here is a
-- row; there it is a migration.
--
-- Nothing in this file decides anything. `last_event_at` and the two counts
-- are maintained by trigger because the board must sort hundreds of shipments
-- without reading every checkpoint — but late, at risk, silent and current
-- position are computed in src/lib/journey.ts, from `now` and the
-- organisation's timezone. The database counts; the library judges.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- Enums
-- ===========================================================================

create type public.shipment_direction as enum ('inbound', 'outbound');

create type public.transport_mode as enum ('road', 'rail', 'air', 'sea', 'multimodal');

-- `status` is a HUMAN-ASSERTED LIFECYCLE, deliberately stored rather than
-- derived. An operator putting a load on hold is an intent, not a computation;
-- the board filters and indexes on it; and no derivation could ever produce
-- 'cancelled'. A trigger keeps it from contradicting its own timestamps.
create type public.shipment_status as enum (
  'planned', 'in_transit', 'on_hold', 'delivered', 'cancelled'
);

-- The last four values are DEFINED BUT NEVER PRODUCED IN V1. South Africa
-- domestic has no customs stages. They exist because `alter type ... add
-- value` is a migration, and four unused labels cost nothing but remove that
-- migration on the day cross-border work starts. Do not "clean them up".
create type public.checkpoint_kind as enum (
  'pickup',
  'depot_in',
  'depot_out',
  'linehaul',
  'hub_scan',
  'out_for_delivery',
  'delivery',
  'pod',
  'exception',
  'border_out',
  'border_in',
  'customs_hold',
  'customs_clear'
);

create type public.checkpoint_exception as enum (
  'delay', 'breakdown', 'accident', 'damage', 'shortage',
  'refused', 'rerouted', 'documentation', 'weather', 'other'
);


-- ===========================================================================
-- shipments
-- ===========================================================================

create table public.shipments (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,

  -- The customer's own waybill or job number. Theirs, not ours — an oversight
  -- product that makes people learn a second reference number for the same
  -- load has added work rather than removed it.
  reference text not null check (length(btrim(reference)) between 1 and 80),

  direction public.shipment_direction not null default 'outbound',
  mode      public.transport_mode not null default 'road',
  status    public.shipment_status not null default 'planned',

  origin_location_id      uuid not null,
  destination_location_id uuid not null,

  carrier_name         text,
  vehicle_registration text,
  driver_name          text,
  goods_description    text,

  -- Money is numeric, never float. NULL means "not disclosed" — never 0.
  -- A customer who will not tell an oversight platform what the cargo is worth
  -- has not declared a worthless load, and summing a 0 into "value at risk"
  -- would quietly understate exactly the number the board exists to show.
  cargo_value numeric(14,2) check (cargo_value is null or cargo_value >= 0),
  currency    char(3) not null default 'ZAR' check (currency ~ '^[A-Z]{3}$'),
  weight_kg   numeric(12,3) check (weight_kg is null or weight_kg > 0),

  -- An operational plan: a truck leaves at a time, and is expected at a time.
  planned_dispatch_at timestamptz,
  planned_delivery_at timestamptz,

  -- THE ONLY `date` COLUMN IN THIS SCHEMA, and the asymmetry is deliberate.
  -- A commercial promise is made in days ("delivered by Thursday"), while an
  -- ETA is an instant. Lateness is judged against the END of this day in the
  -- organisation's timezone, so a shipment promised today is NOT late at
  -- 15:00 — the day is not over. Compare it to an instant instead and the
  -- server, running UTC, rolls the day at 02:00 local and the board screams at
  -- ops every afternoon until they stop reading it.
  promised_delivery_date date,

  dispatched_at timestamptz,
  delivered_at  timestamptz,
  cancelled_at  timestamptz,

  -- Per-shipment override; null means use the organisation's default. A load
  -- crossing the Karoo is legitimately quiet for longer than a metro delivery.
  silence_threshold_days smallint
    check (silence_threshold_days is null or silence_threshold_days between 1 and 30),

  -- Trigger-maintained. NEVER written by a caller. These are counts and a max
  -- — not judgements — and they exist so the board is one indexed query
  -- instead of an aggregate over every checkpoint in the tenant.
  last_event_at            timestamptz,
  checkpoint_count         smallint not null default 0,
  cleared_checkpoint_count smallint not null default 0,

  -- A seam for the future client-facing tracking link, and nothing more.
  -- NO POLICY IN THIS SCHEMA REFERENCES IT. The day someone adds a policy
  -- matching on this token and forgets to check revocation, every shipment in
  -- the system becomes public to anyone holding a uuid.
  public_token uuid not null unique default gen_random_uuid(),

  notes      text,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- THE KEYSTONE. Lets `checkpoints` and `shipment_parties` prove through one
  -- composite foreign key that their org_id agrees with their shipment's,
  -- which keeps their policies a single hop instead of a join through this
  -- table's own policy.
  unique (id, org_id),

  -- Endpoints must belong to the SAME organisation as the shipment. Without
  -- this composite FK a shipment could reference another tenant's depot, and
  -- that depot's name and position would then leak to everyone who can read
  -- the shipment.
  constraint shipments_origin_fkey
    foreign key (origin_location_id, org_id)
    references public.locations (id, org_id) on delete restrict,
  constraint shipments_destination_fkey
    foreign key (destination_location_id, org_id)
    references public.locations (id, org_id) on delete restrict,

  constraint shipments_distinct_endpoints
    check (origin_location_id <> destination_location_id),

  constraint shipments_delivery_after_dispatch
    check (delivered_at is null or dispatched_at is null or delivered_at >= dispatched_at)
);

-- References are unique per organisation, case- and space-insensitively. Two
-- shipments that differ only by "  ABC-1 " vs "abc-1" are a data-entry slip,
-- not two loads.
create unique index shipments_org_reference_idx
  on public.shipments (org_id, upper(btrim(reference)));

create index shipments_board_idx
  on public.shipments (org_id, status, promised_delivery_date);

-- The "silent shipment" query: open shipments ordered by how long they have
-- been quiet.
create index shipments_silence_idx
  on public.shipments (org_id, last_event_at)
  where status in ('planned', 'in_transit', 'on_hold');

create index shipments_recent_idx on public.shipments (org_id, created_at desc);
create index shipments_origin_idx on public.shipments (origin_location_id);
create index shipments_destination_idx on public.shipments (destination_location_id);

create trigger shipments_set_updated_at
  before update on public.shipments
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- checkpoints — the ordered journey
-- ===========================================================================

create table public.checkpoints (
  id          uuid primary key default gen_random_uuid(),
  -- Denormalised from the shipment and NOT redundant. The composite FK below
  -- proves the two agree; removing this column would make every checkpoint
  -- read a two-hop RLS evaluation through the shipments policy, per row.
  org_id      uuid not null,
  shipment_id uuid not null,

  -- GAPPED, IN STEPS OF 100. A stage inserted between Harrismith (200) and
  -- Durban (300) becomes 250, with nothing renumbered — which matters because
  -- PostgREST cannot wrap a multi-row reorder in a transaction, and a
  -- non-deferrable unique index would reject the intermediate state.
  sequence_no integer not null check (sequence_no > 0),

  kind  public.checkpoint_kind not null,
  label text not null check (length(btrim(label)) between 1 and 160),

  -- Where it happened. A location, a gazetteer place, or an operator-supplied
  -- pin — in that order of preference. Never geocoded.
  location_id uuid references public.locations (id) on delete set null,
  sa_place_id uuid references public.sa_places (id) on delete set null,
  latitude    numeric(9,6),
  longitude   numeric(9,6),

  planned_at timestamptz,

  -- NULL MEANS PENDING. The entire state machine turns on this one column:
  -- cleared, current position, next expected, overdue and skipped are all
  -- derived from which checkpoints have an actual_at and which do not.
  actual_at timestamptz,

  exception_kind public.checkpoint_exception,
  note           text,

  recorded_by uuid references auth.users (id) on delete set null,
  -- When it was LOGGED, as against when it HAPPENED. The gap between the two
  -- is itself oversight information: a checkpoint entered three hours late
  -- tells you something about the operation.
  recorded_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint checkpoints_shipment_fkey
    foreign key (shipment_id, org_id)
    references public.shipments (id, org_id) on delete cascade,

  constraint checkpoints_sequence_unique unique (shipment_id, sequence_no),

  constraint checkpoints_coords_paired
    check ((latitude is null) = (longitude is null)),

  constraint checkpoints_on_earth
    check (
      latitude is null
      or (latitude between -90 and 90 and longitude between -180 and 180)
    ),

  -- A checkpoint with neither a plan nor an actual is not an event. It would
  -- render as a blank row on the spine that can never resolve.
  constraint checkpoints_is_an_event
    check (planned_at is not null or actual_at is not null),

  constraint checkpoints_recorded_when_actual
    check (actual_at is null or recorded_at is not null)
);

create index checkpoints_journey_idx
  on public.checkpoints (shipment_id, sequence_no) include (actual_at, planned_at);

-- Next-expected lookup.
create index checkpoints_pending_idx
  on public.checkpoints (shipment_id, sequence_no)
  where actual_at is null;

create index checkpoints_exception_idx
  on public.checkpoints (org_id, actual_at desc)
  where exception_kind is not null;

create trigger checkpoints_set_updated_at
  before update on public.checkpoints
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- Triggers
-- ===========================================================================
-- ONE TRIGGER FUNCTION PER TABLE. plpgsql resolves every `new.<field>`
-- reference against the row's actual type, so a function shared across tables
-- that mentions `new.shipment_id` fails at runtime when it fires for a table
-- without that column — even inside a branch that never runs.

-- `recorded_at` and `recorded_by` are stamped when a checkpoint first becomes
-- actual. A caller may not supply them: the point of the field is to record
-- when the system was told, which a caller is not a reliable witness to.
create or replace function public.checkpoints_stamp_recorded()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.actual_at is null then
    -- Un-cleared: there is nothing recorded any more. Leaving a stale
    -- recorded_at behind would make a corrected mistake look like an event
    -- that still happened.
    new.recorded_at := null;
    new.recorded_by := null;

  elsif tg_op = 'INSERT' or old.actual_at is null then
    -- First time this checkpoint became actual.
    new.recorded_at := now();
    new.recorded_by := coalesce((select auth.uid()), new.recorded_by);

  else
    -- Already recorded. Keep the original stamp and IGNORE whatever the
    -- caller supplied.
    --
    -- Without this branch a caller can rewrite recorded_at on an
    -- already-cleared checkpoint, and the gap between actual_at and
    -- recorded_at — which is the only evidence of how late the operation logs
    -- its events — becomes whatever the client says it is. `updated_at`
    -- already records that a correction happened; recorded_at means "when we
    -- were first told", and that does not change.
    new.recorded_at := old.recorded_at;
    new.recorded_by := old.recorded_by;
  end if;

  return new;
end;
$fn$;

create trigger checkpoints_stamp_recorded
  before insert or update on public.checkpoints
  for each row execute function public.checkpoints_stamp_recorded();


-- Keeps the shipment's denormalised journey summary in step with its
-- checkpoints. Callers never write these three columns.
create or replace function public.checkpoints_touch_shipment()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target uuid := coalesce(new.shipment_id, old.shipment_id);
begin
  update public.shipments s
  set last_event_at = sub.last_event_at,
      checkpoint_count = sub.total,
      cleared_checkpoint_count = sub.cleared
  from (
    select
      max(actual_at)                             as last_event_at,
      count(*)                                   as total,
      count(*) filter (where actual_at is not null) as cleared
    from public.checkpoints
    where shipment_id = target
  ) sub
  where s.id = target;

  return null;
end;
$fn$;

create trigger checkpoints_touch_shipment
  after insert or update or delete on public.checkpoints
  for each row execute function public.checkpoints_touch_shipment();


-- Keeps `status` from contradicting the shipment's own timestamps. It does not
-- invent transitions: an operator still chooses 'on_hold', and nothing here
-- moves a shipment backwards.
create or replace function public.shipments_sync_status()
returns trigger
language plpgsql
as $fn$
begin
  if new.cancelled_at is not null then
    new.status := 'cancelled';
  elsif new.delivered_at is not null then
    new.status := 'delivered';
  elsif new.dispatched_at is not null and new.status = 'planned' then
    new.status := 'in_transit';
  end if;

  return new;
end;
$fn$;

create trigger shipments_sync_status
  before insert or update on public.shipments
  for each row execute function public.shipments_sync_status();


-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Every policy is scoped `to authenticated`. See the note in 0001.
--
-- The SELECT policies here are WIDENED in 0005 so that an organisation which
-- is party to a shipment can read it. Until then there is no cross-tenant read
-- path at all, which is deliberate: the riskiest policies in the system arrive
-- last, alone, in a migration with nothing else in it.

alter table public.shipments enable row level security;
alter table public.checkpoints enable row level security;

create policy shipments_select_member on public.shipments
  for select to authenticated using (
    public.is_org_member(org_id) or public.is_platform_admin()
  );
create policy shipments_insert_staff on public.shipments
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy shipments_update_staff on public.shipments
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy shipments_delete_admin on public.shipments
  for delete to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );

create policy checkpoints_select_member on public.checkpoints
  for select to authenticated using (
    public.is_org_member(org_id) or public.is_platform_admin()
  );
create policy checkpoints_insert_staff on public.checkpoints
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy checkpoints_update_staff on public.checkpoints
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy checkpoints_delete_admin on public.checkpoints
  for delete to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );

-- ============================================================
-- 0005_parties.sql
-- ============================================================
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

-- ============================================================
-- 0006_provisioning.sql
-- ============================================================
-- 0006_provisioning.sql — the two things the admin screens cannot do with RLS
-- alone.
--
-- Both are `security definer`, so both are security-critical code and obey the
-- same five rules as the predicates in 0001: definer, pinned search_path,
-- stable or volatile as appropriate, NO user-id parameter, and execute revoked
-- from public and anon.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- org_members — who else is in my organisation
-- ===========================================================================
-- An org admin needs their colleagues' names and email addresses to manage a
-- team. Those live in `auth.users` and `profiles`, and RLS cannot reach them:
-- `profiles` is own-row-only, deliberately.
--
-- THE LAZY FIX WOULD HAVE BEEN TO WIDEN THAT POLICY to "anyone who shares an
-- organisation with me". That would expose every profile column to every
-- colleague, forever, for the sake of two fields on one screen. This function
-- returns exactly the five values the screen renders and nothing else.

create or replace function public.org_members(target_org uuid)
returns table (
  user_id    uuid,
  full_name  text,
  email      text,
  role       public.membership_role,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  -- The authorisation check is the first statement in the body, before any
  -- data is touched. A definer function without one is an open door.
  if not (
    public.has_org_role(target_org, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  ) then
    raise exception 'Not permitted to list members of this organisation'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    m.user_id,
    p.full_name,
    u.email::text,
    m.role,
    m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.org_id = target_org
  order by m.created_at;
end;
$fn$;


-- ===========================================================================
-- claim_invitations — for somebody invited AFTER they already had an account
-- ===========================================================================
-- `handle_new_user` converts pending invitations into memberships when a user
-- first appears. It cannot help a user who already exists and is later invited
-- to a second organisation: the trigger has already fired, once, forever.
--
-- Without this, that user sits on /no-access with a pending invitation that
-- nothing will ever action — a dead end with no error message, which is the
-- worst kind.
--
-- It matches on the email `auth.users` holds for the CALLER, never on anything
-- supplied by them, so it can only ever claim invitations addressed to the
-- account they are signed in as.

create or replace function public.claim_invitations()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  caller_email text;
  claimed      integer;
begin
  select lower(btrim(u.email)) into caller_email
  from auth.users u
  where u.id = (select auth.uid());

  if caller_email is null then
    return 0;
  end if;

  with pending as (
    select i.id, i.org_id, i.role, i.invited_by
    from public.invitations i
    where i.email = caller_email
      and i.accepted_at is null
      and i.revoked_at is null
      and (i.expires_at is null or i.expires_at > now())
  ),
  inserted as (
    insert into public.memberships (org_id, user_id, role, invited_by)
    select p.org_id, (select auth.uid()), p.role, p.invited_by
    from pending p
    on conflict (org_id, user_id) do nothing
    returning 1
  )
  update public.invitations i
  set accepted_at = now(),
      accepted_by = (select auth.uid())
  from pending p
  where i.id = p.id;

  get diagnostics claimed = row_count;
  return claimed;
end;
$fn$;


revoke execute on function public.org_members(uuid) from public, anon;
revoke execute on function public.claim_invitations() from public, anon;

grant execute on function public.org_members(uuid) to authenticated;
grant execute on function public.claim_invitations() to authenticated;

-- ============================================================
-- 0007_collaboration.sql
-- ============================================================
-- 0007_collaboration.sql — announcements, messages and tasks.
--
-- THIS MIGRATION ADDS THE FIRST WRITE PATH FOR A PARTY ORGANISATION, and that
-- deserves to be read carefully rather than skimmed.
--
-- Non-negotiable #6 says: "Any policy that grants a party insert, update or
-- delete ON A SHIPMENT IT DOES NOT OWN is a bug." Read precisely, that governs
-- the oversight record — shipments, checkpoints, locations, shipment_parties —
-- and NOT ONE POLICY ON THOSE FOUR TABLES CHANGES HERE. A message is
-- correspondence *about* a journey, not a claim about the journey. A consignee
-- still cannot say "it was delivered"; they can only ask.
--
-- Four risks come with that, each answered structurally rather than by care:
--
--   A forged sender — a party inserting a message that appears to come from
--   the carrier's own staff, inside the carrier's own interface. This is a
--   TRUST leak rather than a data leak, and it is the worst thing here.
--   Answered by requiring sender_user_id = auth.uid() and membership of
--   sender_org_id.
--
--   A party broadcasting into the owner's internal stream. Made structurally
--   impossible: a message with a counterparty MUST name a shipment.
--
--   Revocation ceasing to bite. The insert policy carries the same
--   `revoked_at is null` clause the read path does.
--
--   Every existing grant becoming a message channel the moment this applies.
--   Answered by `messaging_enabled`, defaulting to FALSE. The headline
--   feature is therefore off until an admin turns it on per grant — which is
--   right, because the alternative silently widens every grant already in the
--   database.
--
-- ONE MORE RULE, and it is the subtle one: NOTHING HERE MAY TOUCH
-- `shipments.last_event_at`. If a message updated it, a chatty consignee
-- would silence the owner's own "silent shipment" alarm — a party suppressing
-- the carrier's alerting by talking. There is no trigger from `messages` to
-- `shipments`, and `verify:rls` asserts the value is unchanged after a party
-- writes.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- Per-grant messaging
-- ===========================================================================

alter table public.shipment_parties
  add column messaging_enabled boolean not null default false;

comment on column public.shipment_parties.messaging_enabled is
  'Whether this party may send messages about the shipment. Defaults to false '
  'so applying this migration does not retroactively open every existing grant.';


-- ===========================================================================
-- announcements — the "Company" notices
-- ===========================================================================

create table public.announcements (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,

  title text not null check (length(btrim(title)) between 1 and 160),
  body  text not null check (length(btrim(body)) between 1 and 4000),

  pinned       boolean not null default false,
  published_at timestamptz not null default now(),
  expires_at   timestamptz,

  retracted_at timestamptz,
  retracted_by uuid references auth.users (id) on delete set null,

  posted_by  uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint announcements_expires_after_publish
    check (expires_at is null or expires_at > published_at),
  -- Half a retraction is worse than none: it records that something was
  -- withdrawn without recording who did it.
  constraint announcements_retraction_paired
    check ((retracted_at is null) = (retracted_by is null))
);

create index announcements_org_recent_idx
  on public.announcements (org_id, published_at desc);
create index announcements_org_live_idx
  on public.announcements (org_id, published_at desc)
  where retracted_at is null;

create trigger announcements_set_updated_at
  before update on public.announcements
  for each row execute function public.set_updated_at();

-- NOTE: expiry is NOT evaluated here. The row carries `expires_at` and
-- `retracted_at` raw, and src/lib drops expired notices against the server's
-- captured `now`. "Has this expired" is a judgement against a clock, and in
-- this codebase judgements live in the pure layer where the clock is an
-- argument. Same reasoning as `lateness()`.


-- ===========================================================================
-- messages
-- ===========================================================================

create table public.messages (
  id uuid primary key default gen_random_uuid(),

  -- Always the OWNING tenant — the organisation that hosts the conversation.
  -- Never nullable, so every policy on this table is one hop.
  org_id uuid not null,

  -- Null means an internal, organisation-wide message. That is what the
  -- dashboard's broadcast composer sends, and it is why this is nullable
  -- rather than there being a second table.
  shipment_id uuid,

  -- Null means internal. Set means a two-party channel between the owner and
  -- exactly one counterparty.
  --
  -- This column is why a THIRD party organisation on the same shipment cannot
  -- read the conversation. A design with a plain `visibility = 'shared'` flag
  -- would hand a broker the consignee's messages, and would look correct.
  counterparty_org_id uuid references public.organisations (id) on delete cascade,

  sender_org_id  uuid not null references public.organisations (id),
  sender_user_id uuid not null references auth.users (id),

  body text not null check (length(btrim(body)) between 1 and 4000),

  -- Correspondence is retracted, never erased.
  retracted_at timestamptz,
  retracted_by uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),

  constraint messages_counterparty_needs_shipment
    check (counterparty_org_id is null or shipment_id is not null),
  constraint messages_counterparty_not_owner
    check (counterparty_org_id is null or counterparty_org_id <> org_id),
  constraint messages_sender_is_a_participant
    check (sender_org_id = org_id or sender_org_id = counterparty_org_id),
  constraint messages_retraction_paired
    check ((retracted_at is null) = (retracted_by is null)),

  -- Proves the message's tenant agrees with its shipment's.
  --
  -- CAREFUL: Postgres foreign keys are MATCH SIMPLE, so a row with a null
  -- `shipment_id` satisfies this trivially. That is the behaviour we want for
  -- org-wide messages — but it means their tenancy rests on the insert policy
  -- and the `sender_org_id = org_id` constraint alone, not on this FK. That
  -- gap is asserted in verify-behaviour rather than assumed.
  constraint messages_shipment_fkey
    foreign key (shipment_id, org_id)
    references public.shipments (id, org_id) on delete cascade
);

create index messages_org_recent_idx on public.messages (org_id, created_at desc);
create index messages_shipment_idx
  on public.messages (shipment_id, created_at desc)
  where shipment_id is not null;
-- The index the entire party-side inbox depends on.
create index messages_counterparty_idx
  on public.messages (counterparty_org_id, created_at desc)
  where counterparty_org_id is not null;


-- ===========================================================================
-- message_reads — unread counts
-- ===========================================================================
-- Deliberately carries no org_id. Non-negotiable #5 binds OWNABLE ENTITIES; a
-- read receipt is owned by a person, like `profiles` and `platform_admins`,
-- which also carry none.

create table public.message_reads (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  read_at    timestamptz not null default now(),

  primary key (message_id, user_id)
);


-- ===========================================================================
-- tasks
-- ===========================================================================

create type public.task_status   as enum ('open', 'in_progress', 'blocked', 'done', 'cancelled');
create type public.task_priority as enum ('low', 'normal', 'high', 'urgent');

create table public.tasks (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null,

  -- Nullable: "chase the Durban POD" and "renew the fleet insurance" are both
  -- real work, and forcing the second to invent a shipment would be worse
  -- than a nullable column with a composite FK proving agreement.
  shipment_id uuid,

  title  text not null check (length(btrim(title)) between 1 and 160),
  detail text check (detail is null or length(btrim(detail)) between 1 and 2000),

  status   public.task_status not null default 'open',
  priority public.task_priority not null default 'normal',

  -- `timestamptz`, not `date`. Non-negotiable #9: promised_delivery_date is
  -- the ONLY date column, because it is a commercial promise made in days.
  -- A task is due at a time.
  due_at timestamptz,

  assigned_to uuid references auth.users (id) on delete set null,
  assigned_by uuid not null references auth.users (id),

  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,

  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tasks_shipment_fkey
    foreign key (shipment_id, org_id)
    references public.shipments (id, org_id) on delete cascade,

  constraint tasks_done_has_completion
    check ((status = 'done') = (completed_at is not null)),

  -- A completer implies a completion time, but NOT the reverse.
  --
  -- The obvious `(completed_at is null) = (completed_by is null)` is wrong
  -- here, and the verification caught it: `auth.uid()` is null when a task is
  -- completed outside a user session — an admin running SQL directly, or a
  -- future batch job — and the trigger would then stamp the time, fail to
  -- stamp the person, and the write would be rejected with a constraint name
  -- instead of anything useful. "Completed, completer unknown" is a real and
  -- honest state; "completed by someone, at no particular time" is not.
  constraint tasks_completer_implies_completion
    check (completed_by is null or completed_at is not null)
);

create index tasks_org_due_idx
  on public.tasks (org_id, due_at)
  where status in ('open', 'in_progress', 'blocked');
create index tasks_assignee_idx
  on public.tasks (assigned_to, status)
  where assigned_to is not null;
create index tasks_shipment_idx
  on public.tasks (shipment_id)
  where shipment_id is not null;

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- Task triggers — one function per table, per the rule in 0004
-- ===========================================================================

-- An assignee must be a member of the task's organisation.
--
-- THIS CLOSES A GENUINE CROSS-TENANT PATH. Without it an admin could assign a
-- task to an arbitrary uuid, and the day anything grants visibility to an
-- assignee, that becomes a window into another tenant.
--
-- `security definer` is justified on the house rule's own terms rather than
-- for convenience: `memberships`' SELECT policy is self-or-admin, so an
-- OPERATOR creating a task would see no membership rows at all and the check
-- would reject every legitimate assignment. It is a visibility problem.
create or replace function public.tasks_guard_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.assigned_to is not null
     and not exists (
       select 1 from public.memberships m
       where m.user_id = new.assigned_to
         and m.org_id = new.org_id
     )
  then
    raise exception 'Cannot assign a task to someone outside the organisation'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

create trigger tasks_guard_assignee
  before insert or update on public.tasks
  for each row execute function public.tasks_guard_assignee();


-- Completion is stamped by the database, not supplied by the caller — the
-- same discipline as `checkpoints_stamp_recorded()` and for the same reason:
-- the caller is not a reliable witness to when the system was told.
create or replace function public.tasks_stamp_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.status = 'done' then
    if tg_op = 'INSERT' or old.status <> 'done' then
      new.completed_at := now();
      new.completed_by := coalesce((select auth.uid()), new.completed_by);
    else
      -- Already done: keep the original stamp, ignore the caller.
      new.completed_at := old.completed_at;
      new.completed_by := old.completed_by;
    end if;
  else
    -- Moved off done — a task reopened must not look finished.
    new.completed_at := null;
    new.completed_by := null;
  end if;

  return new;
end;
$fn$;

create trigger tasks_stamp_completion
  before insert or update on public.tasks
  for each row execute function public.tasks_stamp_completion();


-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Every policy scoped `to authenticated`. See the note in 0001.

alter table public.announcements enable row level security;
alter table public.messages      enable row level security;
alter table public.message_reads enable row level security;
alter table public.tasks         enable row level security;

-- --- announcements ---------------------------------------------------------
-- Internal only: not parties, and deliberately NOT the platform admin either.
-- An internal staff notice is internal.
create policy announcements_select_member on public.announcements
  for select to authenticated using (public.is_org_member(org_id));
create policy announcements_insert_admin on public.announcements
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    and posted_by = (select auth.uid())
  );
create policy announcements_update_admin on public.announcements
  for update to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );
-- No delete: notices are retracted.

revoke update on public.announcements from authenticated;
grant update (title, body, pinned, expires_at, retracted_at, retracted_by)
  on public.announcements to authenticated;

-- --- messages --------------------------------------------------------------
-- NOTE the absence of any `is_platform_admin()` branch, on every policy here.
-- The platform owner runs the platform; they have no business reading their
-- customers' correspondence. verify-behaviour asserts this stays true, because
-- "for consistency with every other table" is a very easy thing to add.
--
-- NO NEW security definer FUNCTION, deliberately. A policy on `messages`
-- reading `shipment_parties` does not recurse — that table's own SELECT policy
-- admits the row to both sides of a grant — so a plain `exists` works as the
-- querying role and is RLS-filtered on the way. This migration therefore adds
-- no RLS-bypassing code at all.
create policy messages_select on public.messages
  for select to authenticated using (
    public.is_org_member(org_id)
    or (
      counterparty_org_id is not null
      and public.is_org_member(counterparty_org_id)
      and public.can_view_shipment(shipment_id)
    )
  );

create policy messages_insert on public.messages
  for insert to authenticated with check (
    -- You are who you say you are. This is the forged-sender defence.
    sender_user_id = (select auth.uid())
    and public.is_org_member(sender_org_id)
    and (
      -- The owning organisation's own staff.
      (
        sender_org_id = org_id
        and case
              when shipment_id is null
                then public.has_org_role(org_id, array['admin']::public.membership_role[])
              else public.is_org_member(org_id)
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
      -- Or a live, messaging-enabled party, writing as itself.
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

create policy messages_update_sender on public.messages
  for update to authenticated using (sender_user_id = (select auth.uid()))
  with check (sender_user_id = (select auth.uid()));
-- No delete.

-- Column privileges make the body immutable and the tenant unmovable, which
-- `with check` alone cannot: `sender_user_id = auth.uid()` stays true after a
-- sender rewrites their own message into another organisation.
revoke update on public.messages from authenticated;
grant update (retracted_at, retracted_by) on public.messages to authenticated;

-- --- message_reads ---------------------------------------------------------
create policy message_reads_select_own on public.message_reads
  for select to authenticated using (user_id = (select auth.uid()));
create policy message_reads_insert_own on public.message_reads
  for insert to authenticated with check (
    user_id = (select auth.uid())
    -- RLS-filtered, so you can only mark read a message you can read.
    and exists (select 1 from public.messages m where m.id = message_id)
  );
create policy message_reads_update_own on public.message_reads
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy message_reads_delete_own on public.message_reads
  for delete to authenticated using (user_id = (select auth.uid()));

-- --- tasks -----------------------------------------------------------------
-- There is deliberately NO `or assigned_to = (select auth.uid())` branch on
-- select. The assignee is always a member — `tasks_guard_assignee` guarantees
-- it — so the branch would be redundant, and a redundant entitlement path is
-- how two paths drift apart.
create policy tasks_select_member on public.tasks
  for select to authenticated using (public.is_org_member(org_id));
create policy tasks_insert_staff on public.tasks
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    and created_by = (select auth.uid())
  );
create policy tasks_update_staff_or_assignee on public.tasks
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    or assigned_to = (select auth.uid())
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
    or assigned_to = (select auth.uid())
  );
-- No delete: status 'cancelled', as with invitations and party grants.

revoke update on public.tasks from authenticated;
grant update (title, detail, status, priority, due_at, assigned_to,
              completed_at, completed_by)
  on public.tasks to authenticated;

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

commit;
