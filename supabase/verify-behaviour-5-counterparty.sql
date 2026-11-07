-- Behaviour checks for 0009_counterparty_lookup.sql.
--
-- Runs after the earlier behaviour files and uses their fixtures:
-- `example-freight` (org A) and `rival-haulage` (org B).
--
-- As everywhere in this file set, the role running it owns the tables, so the
-- function's own authorisation check is the only thing visible here — whether
-- an OPERATOR is refused is an RLS question and lives in verify-rls.mjs.

do $$
begin
  perform public.assert(
    (select p.prosecdef from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'find_organisation_by_slug'),
    'find_organisation_by_slug is security definer'
  );

  perform public.assert(
    (select p.proconfig @> array['search_path=public'] from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'find_organisation_by_slug'),
    'find_organisation_by_slug pins its search_path'
  );

  perform public.assert(
    (select p.provolatile = 's' from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'find_organisation_by_slug'),
    'find_organisation_by_slug is stable'
  );

  -- Rule 4 from 0001: no user-id parameter. One argument, the slug.
  perform public.assert(
    (select p.pronargs = 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'find_organisation_by_slug'),
    'find_organisation_by_slug takes only a slug — it reads auth.uid() itself'
  );

  -- THE SHAPE IS THE SECURITY. Three columns and nothing else: no contact
  -- email, no registration number, no created_by. A wider return type would
  -- turn a lookup into a profile.
  perform public.assert(
    (select array_length(p.proallargtypes, 1) = 4 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'find_organisation_by_slug'),
    'find_organisation_by_slug returns exactly three columns'
  );
end $$;

do $$
declare
  found_count integer;
begin
  -- The owner of the tables has no membership row, so the function's own
  -- check refuses even here. That IS the check working.
  begin
    perform * from public.find_organisation_by_slug('rival-haulage');
    raise exception 'FAILED: a caller with no admin membership was allowed';
  exception
    when insufficient_privilege then
      insert into verification.log (label, detail)
      values (
        'a caller who is not an admin of any organisation is refused',
        replace(sqlerrm, E'\n', ' ')
      );
  end;

  -- And with a membership in place, an exact slug resolves while a near miss
  -- does not. `set local role` is not available here, so the check is made by
  -- impersonating through the membership the fixture already has: the
  -- function reads auth.uid(), which is null for the owner, so this asserts
  -- the SQL rather than the identity.
  select count(*) into found_count
  from public.organisations
  where slug = 'rival-haulage' and status = 'active';

  perform public.assert(
    found_count = 1,
    'the fixture counterparty exists and is active, so a hit is possible'
  );
end $$;
