-- Exercises what the migrations CLAIM, rather than merely that they parse.
--
-- Run by `npm run verify:migrations` after every migration has been applied to
-- a throwaway database. Every constraint and trigger a migration introduces
-- should gain a check here — a constraint nobody has seen reject anything is
-- a comment with semicolons in it.
--
-- WHAT THIS CANNOT DO: prove row-level security. The role running it owns the
-- tables, and a table owner bypasses its own RLS. `npm run verify:rls` covers
-- that against a live project with the anon key. A missing table fails loudly
-- on first load; a missing policy fails silently, and only in the direction
-- that leaks.

-- ---------------------------------------------------------------------------
-- Assertion helpers
-- ---------------------------------------------------------------------------
--
-- Results go into a table rather than out through `raise notice`. Notices are
-- delivered out of band and are easily swallowed by a driver, and a run that
-- prints nothing looks identical to a run that asserted nothing. The runner
-- selects from this table at the end, so the count of passed checks is itself
-- part of the output — if this file ever stops executing halfway, the number
-- drops and that is visible.

-- In its own schema, deliberately. Anything in `public` would be picked up by
-- the "every public table has RLS enabled" sweep further down, and a test
-- fixture tripping the test is a confusing way to spend an afternoon.
create schema if not exists verification;

create table if not exists verification.log (
  seq    serial primary key,
  label  text not null,
  detail text
);

truncate verification.log restart identity;

create or replace function public.assert(condition boolean, label text)
returns void
language plpgsql
as $fn$
begin
  if condition is not true then
    raise exception 'FAILED: %', label;
  end if;
  insert into verification.log (label) values (label);
end;
$fn$;

-- Asserts that a statement is rejected.
--
-- The BEGIN/EXCEPTION block opens a sub-transaction, so a statement that
-- unexpectedly succeeds would otherwise leave its rows behind. It cannot: the
-- success path raises, which aborts everything.
create or replace function public.assert_rejects(stmt text, label text)
returns void
language plpgsql
as $fn$
begin
  begin
    execute stmt;
  exception when others then
    insert into verification.log (label, detail)
    values (label, replace(sqlerrm, E'\n', ' '));
    return;
  end;
  raise exception 'FAILED: % — the statement was ACCEPTED and should not have been', label;
end;
$fn$;


-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

do $$
declare
  owner_id    uuid := '11111111-1111-1111-1111-111111111111';
  admin_id    uuid := '22222222-2222-2222-2222-222222222222';
  operator_id uuid := '33333333-3333-3333-3333-333333333333';
  org_a       uuid;
begin
  -- Inserting into auth.users fires handle_new_user(), so these also exercise
  -- the bootstrap trigger.
  insert into auth.users (id, email) values
    (owner_id,    'owner@example.test'),
    (admin_id,    'admin@example.test'),
    (operator_id, 'operator@example.test');

  insert into public.platform_admins (user_id, note)
  values (owner_id, 'verification fixture');

  insert into public.organisations (name, slug, is_subscriber, created_by)
  values ('Example Freight', 'example-freight', true, owner_id)
  returning id into org_a;

  insert into public.memberships (org_id, user_id, role)
  values (org_a, admin_id, 'admin'), (org_a, operator_id, 'operator');
end;
$$;


-- ---------------------------------------------------------------------------
-- profiles — the bootstrap trigger
-- ---------------------------------------------------------------------------

do $$
begin
  perform public.assert(
    (select count(*) from public.profiles) = 3,
    'handle_new_user creates a profile for every auth user'
  );
  perform public.assert(
    (select timezone from public.profiles limit 1) = 'Africa/Johannesburg',
    'profiles default to the South African timezone'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- organisations
-- ---------------------------------------------------------------------------

do $$
declare owner_id uuid := '11111111-1111-1111-1111-111111111111';
begin
  perform public.assert_rejects(
    format(
      'insert into public.organisations (name, slug, created_by) values (%L, %L, %L)',
      'Bad Slug', 'Not A Slug', owner_id
    ),
    'organisations.slug rejects a value that is not url-safe'
  );

  perform public.assert_rejects(
    format(
      'insert into public.organisations (name, slug, created_by) values (%L, %L, %L)',
      '   ', 'blank-name', owner_id
    ),
    'organisations.name rejects whitespace-only'
  );

  perform public.assert_rejects(
    format(
      'insert into public.organisations (name, slug, created_by, default_silence_threshold_days) values (%L, %L, %L, 0)',
      'Zero Threshold', 'zero-threshold', owner_id
    ),
    'default_silence_threshold_days rejects 0'
  );

  perform public.assert_rejects(
    format(
      'insert into public.organisations (name, slug, created_by, contact_email) values (%L, %L, %L, %L)',
      'Upper Email', 'upper-email', owner_id, 'Someone@Example.test'
    ),
    'contact_email rejects a non-normalised address'
  );

  perform public.assert_rejects(
    'insert into public.organisations (name, slug, created_by) values (''Dup'', ''example-freight'', ''11111111-1111-1111-1111-111111111111'')',
    'organisations.slug is unique'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  admin_id uuid := '22222222-2222-2222-2222-222222222222';
begin
  perform public.assert_rejects(
    format(
      'insert into public.memberships (org_id, user_id, role) values (%L, %L, %L)',
      org_a, admin_id, 'viewer'
    ),
    'a user cannot hold two roles in one organisation'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- The last-admin guard
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  admin_id uuid := '22222222-2222-2222-2222-222222222222';
begin
  perform public.assert_rejects(
    format('delete from public.memberships where org_id = %L and user_id = %L', org_a, admin_id),
    'the only admin of an organisation cannot be deleted'
  );

  perform public.assert_rejects(
    format(
      'update public.memberships set role = ''operator'' where org_id = %L and user_id = %L',
      org_a, admin_id
    ),
    'the only admin of an organisation cannot be demoted'
  );

  -- An operator may leave freely — the guard must not over-reach.
  delete from public.memberships
  where org_id = org_a and user_id = '33333333-3333-3333-3333-333333333333';

  perform public.assert(
    (select count(*) from public.memberships where org_id = org_a) = 1,
    'a non-admin member can still be removed'
  );

  -- Restore for later checks.
  insert into public.memberships (org_id, user_id, role)
  values (org_a, '33333333-3333-3333-3333-333333333333', 'operator');
end;
$$;


-- ---------------------------------------------------------------------------
-- invitations, and the bootstrap that consumes them
-- ---------------------------------------------------------------------------

do $$
declare
  org_a     uuid := (select id from public.organisations where slug = 'example-freight');
  admin_id  uuid := '22222222-2222-2222-2222-222222222222';
  invitee   uuid := '44444444-4444-4444-4444-444444444444';
  expired   uuid := '55555555-5555-5555-5555-555555555555';
  revoked   uuid := '66666666-6666-6666-6666-666666666666';
begin
  perform public.assert_rejects(
    format(
      'insert into public.invitations (org_id, email, role, invited_by) values (%L, %L, %L, %L)',
      org_a, 'NotNormalised@Example.test', 'viewer', admin_id
    ),
    'invitations.email rejects a non-normalised address'
  );

  perform public.assert_rejects(
    format(
      'insert into public.invitations (org_id, email, role, invited_by) values (%L, %L, %L, %L)',
      org_a, 'nodomain', 'viewer', admin_id
    ),
    'invitations.email rejects an address with no @'
  );

  -- A pending invitation becomes a membership when the user appears.
  insert into public.invitations (org_id, email, role, invited_by)
  values (org_a, 'invitee@example.test', 'viewer', admin_id);

  insert into auth.users (id, email) values (invitee, 'invitee@example.test');

  perform public.assert(
    exists (
      select 1 from public.memberships
      where org_id = org_a and user_id = invitee and role = 'viewer'
    ),
    'a pending invitation becomes a membership on signup'
  );
  perform public.assert(
    (select accepted_by from public.invitations where email = 'invitee@example.test') = invitee,
    'the invitation is stamped accepted_by'
  );

  perform public.assert_rejects(
    format(
      'insert into public.invitations (org_id, email, role, invited_by) values (%L, %L, %L, %L)',
      org_a, 'pending@example.test', 'viewer', admin_id
    ) || '; ' || format(
      'insert into public.invitations (org_id, email, role, invited_by) values (%L, %L, %L, %L)',
      org_a, 'pending@example.test', 'operator', admin_id
    ),
    'only one pending invitation per email per organisation'
  );

  -- An EXPIRED invitation must NOT grant access.
  insert into public.invitations (org_id, email, role, invited_by, expires_at)
  values (org_a, 'expired@example.test', 'admin', admin_id, now() - interval '1 day');

  insert into auth.users (id, email) values (expired, 'expired@example.test');

  perform public.assert(
    not exists (select 1 from public.memberships where user_id = expired),
    'an expired invitation does not grant membership'
  );

  -- A REVOKED invitation must NOT grant access.
  insert into public.invitations (org_id, email, role, invited_by, revoked_at, revoked_by)
  values (org_a, 'revoked@example.test', 'admin', admin_id, now(), admin_id);

  insert into auth.users (id, email) values (revoked, 'revoked@example.test');

  perform public.assert(
    not exists (select 1 from public.memberships where user_id = revoked),
    'a revoked invitation does not grant membership'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- The security definer predicates
-- ---------------------------------------------------------------------------

do $$
declare
  org_a       uuid := (select id from public.organisations where slug = 'example-freight');
  owner_id    uuid := '11111111-1111-1111-1111-111111111111';
  operator_id uuid := '33333333-3333-3333-3333-333333333333';
  outsider    uuid := '77777777-7777-7777-7777-777777777777';
begin
  insert into auth.users (id, email) values (outsider, 'outsider@example.test');

  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform public.assert(public.is_platform_admin(), 'is_platform_admin() is true for the owner');

  perform set_config('request.jwt.claim.sub', operator_id::text, true);
  perform public.assert(not public.is_platform_admin(), 'is_platform_admin() is false for an operator');
  perform public.assert(public.is_org_member(org_a), 'is_org_member() sees the operator''s own org');
  perform public.assert(
    public.has_org_role(org_a, array['operator']::public.membership_role[]),
    'has_org_role() matches the operator role'
  );
  perform public.assert(
    not public.has_org_role(org_a, array['admin']::public.membership_role[]),
    'has_org_role() does not promote an operator to admin'
  );
  perform public.assert(
    public.my_org_ids() @> array[org_a],
    'my_org_ids() includes the caller''s org'
  );

  perform set_config('request.jwt.claim.sub', outsider::text, true);
  perform public.assert(not public.is_org_member(org_a), 'is_org_member() is false for an outsider');
  perform public.assert(
    public.my_org_ids() = '{}'::uuid[],
    'my_org_ids() is empty for a user with no memberships'
  );

  -- With no signed-in user at all, nothing is granted. The anon path.
  perform set_config('request.jwt.claim.sub', '', true);
  perform public.assert(not public.is_platform_admin(), 'is_platform_admin() is false when signed out');
  perform public.assert(
    public.my_org_ids() = '{}'::uuid[],
    'my_org_ids() is empty when signed out'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- The definer functions must be locked down
-- ---------------------------------------------------------------------------
-- These are the functions that bypass RLS. If any of them loses its
-- search_path pin, a caller who can create a schema can shadow
-- public.memberships and the function reads THEIR table instead.

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'is_platform_admin', 'my_org_ids', 'is_org_member', 'has_org_role',
    'handle_new_user', 'memberships_guard_last_admin'
  ] loop
    perform public.assert(
      exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn and p.prosecdef
      ),
      format('%s is security definer', fn)
    );
    perform public.assert(
      exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn
          and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
      ),
      format('%s pins its search_path', fn)
    );
  end loop;

  -- None of the callable predicates may be executable by PUBLIC.
  foreach fn in array array['is_platform_admin', 'my_org_ids', 'is_org_member', 'has_org_role'] loop
    perform public.assert(
      not has_function_privilege('public', (
        select p.oid from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn limit 1
      ), 'execute'),
      format('%s is not executable by PUBLIC', fn)
    );
    perform public.assert(
      has_function_privilege('authenticated', (
        select p.oid from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn limit 1
      ), 'execute'),
      format('%s is executable by authenticated', fn)
    );
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- Column privileges on organisations
-- ---------------------------------------------------------------------------
-- RLS filters rows; it cannot say "you may edit the name but not the
-- suspension status". These grants are the mechanism that does.

do $$
begin
  perform public.assert(
    has_column_privilege('authenticated', 'public.organisations', 'name', 'update'),
    'an org admin may update organisations.name'
  );

  perform public.assert(
    not has_column_privilege('authenticated', 'public.organisations', 'status', 'update'),
    'organisations.status is NOT updatable by authenticated'
  );
  perform public.assert(
    not has_column_privilege('authenticated', 'public.organisations', 'slug', 'update'),
    'organisations.slug is NOT updatable by authenticated'
  );
  perform public.assert(
    not has_column_privilege('authenticated', 'public.organisations', 'is_subscriber', 'update'),
    'organisations.is_subscriber is NOT updatable by authenticated'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Every table has RLS enabled
-- ---------------------------------------------------------------------------
-- The generic sweep. A table added later without RLS is the whole product's
-- failure mode, so this must never be narrowed to a hardcoded list.

do $$
declare
  missing text;
begin
  select string_agg(tablename, ', ')
  into missing
  from pg_tables
  where schemaname = 'public' and not rowsecurity;

  perform public.assert(
    missing is null,
    coalesce('every public table has RLS enabled', 'RLS missing on: ' || missing)
  );

  if missing is not null then
    raise exception 'FAILED: RLS is not enabled on: %', missing;
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- platform_admins must have NO write policy
-- ---------------------------------------------------------------------------
-- The most privileged table in the system. With RLS on and no write policy,
-- every insert/update/delete from the application is denied outright.

do $$
begin
  perform public.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'platform_admins'
        and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    'platform_admins has no write policy'
  );
  perform public.assert(
    exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'platform_admins' and cmd = 'SELECT'
    ),
    'platform_admins has a select policy'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Every UPDATE policy carries both USING and WITH CHECK
-- ---------------------------------------------------------------------------
-- The quietest multi-tenant leak in Postgres: with only USING, a row can be
-- targeted legitimately and then rewritten into another tenant. No read-only
-- test catches it, so it is caught structurally here instead.

do $$
declare
  offenders text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
  into offenders
  from pg_policies
  where schemaname = 'public'
    and cmd = 'UPDATE'
    and (with_check is null or qual is null);

  if offenders is not null then
    raise exception 'FAILED: UPDATE policies missing USING or WITH CHECK: %', offenders;
  end if;

  perform public.assert(true, 'every UPDATE policy has both USING and WITH CHECK');
end;
$$;


-- ---------------------------------------------------------------------------
-- Every policy is scoped to a role, never left open to PUBLIC
-- ---------------------------------------------------------------------------
-- A policy with no role list applies to PUBLIC, which includes `anon`. Two
-- consequences, both found by verify:rls rather than by reading the SQL:
-- the policy expression then has to be executable by anonymous callers, and
-- the denial of anonymous access depends on an expression evaluating falsely
-- rather than on no policy matching at all. Scoping is the structural version.

do $$
declare
  offenders text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
  into offenders
  from pg_policies
  where schemaname = 'public'
    and (roles is null or roles = '{public}');

  if offenders is not null then
    raise exception 'FAILED: policies not scoped to a role (they apply to PUBLIC, including anon): %', offenders;
  end if;

  perform public.assert(true, 'every policy is scoped to a role, not left open to PUBLIC');
end;
$$;


-- ---------------------------------------------------------------------------
-- The definer predicates are unreachable by anon
-- ---------------------------------------------------------------------------
-- Supabase's default privileges grant EXECUTE on new functions to anon, so a
-- `revoke ... from public` does NOT take it away — anon holds its own grant.
-- These functions bypass RLS; a signed-out visitor must not reach them.

do $$
declare
  fn text;
begin
  foreach fn in array array['is_platform_admin', 'my_org_ids', 'is_org_member', 'has_org_role'] loop
    perform public.assert(
      not has_function_privilege('anon', (
        select p.oid from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn limit 1
      ), 'execute'),
      format('%s is not executable by anon', fn)
    );
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- updated_at triggers actually fire
-- ---------------------------------------------------------------------------

-- Note what is NOT asserted here: that updated_at increases. `now()` returns
-- the transaction start time, so inside a single transaction a later update
-- produces an identical timestamp and that check would fail for a trigger that
-- works perfectly. What the trigger actually guarantees is that the caller does
-- not get to choose the value — so that is what is tested.

do $$
declare
  org_a   uuid := (select id from public.organisations where slug = 'example-freight');
  stamped timestamptz;
begin
  update public.organisations
  set name = 'Example Freight (Pty) Ltd',
      updated_at = timestamptz '2000-01-01 00:00:00+02'
  where id = org_a;

  select updated_at into stamped from public.organisations where id = org_a;

  perform public.assert(
    stamped = now(),
    'set_updated_at overrides a caller-supplied updated_at on organisations'
  );
end;
$$;

do $$
declare
  admin_id uuid := '22222222-2222-2222-2222-222222222222';
  stamped  timestamptz;
begin
  update public.profiles
  set full_name = 'Verified Name',
      updated_at = timestamptz '2000-01-01 00:00:00+02'
  where id = admin_id;

  select updated_at into stamped from public.profiles where id = admin_id;

  perform public.assert(
    stamped = now(),
    'set_updated_at overrides a caller-supplied updated_at on profiles'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- The gazetteer
-- ---------------------------------------------------------------------------
-- Every coordinate here must be real. These checks cannot prove a town is
-- where the row says it is, but they catch the error that actually happens:
-- a transcribed or sign-dropped value, which renders as confidently as a
-- correct one and which nobody re-checks because the number looks plausible.

do $$
declare
  n integer;
begin
  select count(*) into n from public.sa_places;
  perform public.assert(n >= 400, format('the gazetteer is seeded (%s places)', n));

  perform public.assert(
    not exists (select 1 from public.sa_places where latitude >= 0),
    'no gazetteer latitude is positive — South Africa is entirely south of the equator'
  );

  perform public.assert(
    not exists (
      select 1 from public.sa_places
      where country_code = 'ZA'
        and (latitude not between -35.0 and -22.0 or longitude not between 16.0 and 33.1)
    ),
    'every South African place is inside the national bounding box'
  );

  perform public.assert(
    not exists (
      select 1 from public.sa_places
      group by lower(btrim(name)), round(latitude, 2), round(longitude, 2)
      having count(*) > 1
    ),
    'no gazetteer place is seeded twice at the same position'
  );

  perform public.assert(
    (select count(*) from public.sa_places where wikidata_qid is null) = 0,
    'every gazetteer row carries the source id it came from'
  );

  -- Freight-critical places. If the seed query silently stops returning these,
  -- the product loses the ability to describe a national road journey — and it
  -- would fail quietly, as a type-ahead that returns nothing.
  perform public.assert(
    (select count(*) from public.sa_places
     where lower(name) in (
       'johannesburg', 'durban', 'cape town', 'gqeberha', 'bloemfontein',
       'pretoria', 'polokwane', 'harrismith', 'richards bay', 'beaufort west'
     )) = 10,
    'the ten freight-critical places are all present'
  );

  perform public.assert_rejects(
    'insert into public.sa_places (slug, name, latitude, longitude, kind)
     values (''swapped'', ''Swapped Pair'', 26.2041, 28.0473, ''town'')',
    'a positive latitude is rejected (a sign-dropped pair)'
  );

  perform public.assert_rejects(
    'insert into public.sa_places (slug, name, latitude, longitude, kind)
     values (''offmap'', ''Off Map'', -26.2041, 128.0473, ''town'')',
    'a longitude outside South Africa is rejected'
  );

  perform public.assert_rejects(
    'insert into public.sa_places (slug, name, latitude, longitude, kind)
     values (''johannesburg'', ''Duplicate'', -26.2, 28.0, ''town'')',
    'a duplicate gazetteer slug is rejected'
  );

  perform public.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'sa_places'
        and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    'sa_places has no write policy — the gazetteer changes by migration only'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- locations, and the coordinate fallback
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  jhb      uuid := (select id from public.sa_places where slug = 'johannesburg');
  exact_id uuid;
  place_id uuid;
  none_id  uuid;
  row_     record;
begin
  perform public.assert_rejects(
    format(
      'insert into public.locations (org_id, name, latitude) values (%L, %L, -26.1)',
      org_a, 'Half A Coordinate'
    ),
    'a location with latitude but no longitude is rejected'
  );

  perform public.assert_rejects(
    format(
      'insert into public.locations (org_id, name, latitude, longitude) values (%L, %L, 26.1, 28.0)',
      org_a, 'Northern Hemisphere Depot'
    ),
    'a South African location with a positive latitude is rejected'
  );

  insert into public.locations (org_id, name, kind, latitude, longitude)
  values (org_a, 'Alpha Yard', 'yard', -26.150000, 28.050000)
  returning id into exact_id;

  insert into public.locations (org_id, name, kind, sa_place_id)
  values (org_a, 'Alpha Depot', 'depot', jhb)
  returning id into place_id;

  insert into public.locations (org_id, name, kind)
  values (org_a, 'Unlocated Site', 'other')
  returning id into none_id;

  perform public.assert_rejects(
    format(
      'insert into public.locations (org_id, name) values (%L, %L)',
      org_a, '  alpha yard  '
    ),
    'two locations in one org cannot share a name, ignoring case and spacing'
  );

  select * into row_ from public.location_points where location_id = exact_id;
  perform public.assert(
    row_.coordinate_source = 'exact' and row_.effective_latitude = -26.150000,
    'location_points reports an exact coordinate as exact'
  );

  select * into row_ from public.location_points where location_id = place_id;
  perform public.assert(
    row_.coordinate_source = 'place'
      and row_.effective_latitude = (select latitude from public.sa_places where id = jhb)
      and row_.place_name = 'Johannesburg',
    'location_points falls back to the gazetteer and says so'
  );

  select * into row_ from public.location_points where location_id = none_id;
  perform public.assert(
    row_.coordinate_source = 'unknown' and row_.effective_latitude is null,
    'location_points reports an unlocatable location as unknown, not as 0,0'
  );
end;
$$;


-- The assertion helpers and the fixtures above are deliberately NOT dropped
-- here. `verify-behaviour-*.sql` files run after this one, in filename order,
-- and build on both. The database is thrown away when the run ends.
