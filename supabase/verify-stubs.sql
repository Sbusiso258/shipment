-- Supabase stand-ins, so the migrations can be applied to a plain Postgres.
--
-- Supabase provides the `auth` schema, `auth.users`, `auth.uid()` and the
-- `anon` / `authenticated` / `service_role` roles. A bare Postgres does not.
-- Recreating just enough of them lets `npm run verify:migrations` prove the
-- DDL, the triggers and the constraints actually work before any of it is
-- pasted into a real project's SQL editor.
--
-- This file is NOT part of the migration sequence and must NEVER be run
-- against a Supabase project.

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- The signed-in user id. Tests set it with
--   set local request.jwt.claim.sub = '<uuid>';
-- The real implementation reads the same GUC, so policies written against this
-- behave identically in production.
create or replace function auth.uid()
returns uuid
language sql
stable
as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$fn$;

-- The roles the migrations grant to. Without these, every `grant ... to
-- authenticated` fails and the whole migration aborts — which is itself worth
-- catching here rather than in the Supabase SQL editor.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

-- --------------------------------------------------------------------------
-- Supabase's default privileges.
-- --------------------------------------------------------------------------
-- THIS BLOCK IS WHAT MAKES `verify:rls` MEANINGFUL, and it is easy to get
-- wrong in the dangerous direction.
--
-- A Supabase project ships with default privileges that grant everything in
-- `public` to anon, authenticated and service_role as objects are created. RLS
-- then does the actual filtering. Without reproducing that here, `authenticated`
-- would hold no table privileges at all, every query would fail with
-- "permission denied" before a policy was ever consulted, and a test suite
-- built on that would be asserting the wrong mechanism — passing for a reason
-- that does not exist in production.
--
-- Note `functions` in particular: Supabase grants EXECUTE on new functions to
-- anon as well. A migration that only does `revoke execute ... from public`
-- therefore does NOT take execute away from anon, because anon holds its own
-- explicit grant. Reproducing that here is what lets the RLS suite catch it.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
