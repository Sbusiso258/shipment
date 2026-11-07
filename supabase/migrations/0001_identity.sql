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
