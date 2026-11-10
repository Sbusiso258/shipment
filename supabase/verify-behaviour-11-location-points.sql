-- Behaviour checks for 0015_repair_location_points.sql.
--
-- The drift these guard against cost an afternoon: `location_points` existed
-- in the live project as an empty TABLE rather than a view, so the places list
-- read zero rows while nine real depots sat in `locations`. Nothing in the
-- suites noticed, because every check asked about `locations` and none asked
-- what KIND of relation `location_points` is.

do $$
begin
  -- IT IS A VIEW, not a table. This is the assertion that would have caught
  -- the drift, and the reason it is first.
  perform public.assert(
    (select c.relkind from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'location_points') = 'v',
    'location_points is a view, not a table'
  );

  -- AND IT INVOKES. Without `security_invoker` the view reads its base tables
  -- as the OWNER, which bypasses row-level security on `locations` — every
  -- tenant's depots visible to everybody. A view that merely returns rows
  -- again is not the fix.
  perform public.assert(
    (select reloptions @> array['security_invoker=true'] from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'location_points'),
    '...and it runs as the invoker, so the locations policy still decides'
  );
end $$;


do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  jhb      uuid := (select id from public.sa_places where slug = 'johannesburg');
  with_town    uuid;
  without_town uuid;
begin
  insert into public.locations (org_id, name, kind, sa_place_id)
  values (org_a, 'Point View With Town', 'depot', jhb)
  returning id into with_town;

  -- THE LEFT JOIN, asserted. A location with no gazetteer entry must still
  -- appear. An inner join here would silently hide every depot somebody
  -- recorded without picking a town — which is exactly the shape of failure
  -- 0015 repaired, and it would look identical from the application.
  insert into public.locations (org_id, name, kind, sa_place_id)
  values (org_a, 'Point View Without Town', 'depot', null)
  returning id into without_town;

  perform public.assert(
    (select count(*) from public.location_points
      where location_id in (with_town, without_town)) = 2,
    'a location with no town still appears in the view'
  );

  -- Provenance, which is the whole reason the view exists.
  perform public.assert(
    (select coordinate_source from public.location_points
      where location_id = with_town) = 'place',
    'a location with a town but no pin reports its coordinate as the town''s'
  );

  perform public.assert(
    (select coordinate_source from public.location_points
      where location_id = without_town) = 'unknown',
    '...and one with neither reports unknown rather than inventing a point'
  );

  update public.locations
     set latitude = -29.8587, longitude = 31.0218
   where id = with_town;

  perform public.assert(
    (select coordinate_source from public.location_points
      where location_id = with_town) = 'exact',
    'an exact pin outranks the town it sits in'
  );

  -- `archived_at` is carried through, because `listLocations` filters on it.
  -- If the view dropped the column the service would error; if it dropped the
  -- VALUE, archived places would come back to life.
  update public.locations set archived_at = now() where id = without_town;

  perform public.assert(
    (select count(*) from public.location_points
      where location_id = without_town and archived_at is null) = 0,
    'an archived place is still reported as archived by the view'
  );

  -- CLEAN UP AFTER OURSELVES, and the reason is specific rather than tidiness.
  --
  -- `verify-migrations.mjs` sorts these files LEXICALLY, so `-11-` runs before
  -- `-2-`. Several later files pick their endpoints with
  -- `order by created_at limit 1` and `offset 1` over this organisation's
  -- locations — and `now()` is constant within a transaction, so rows added
  -- here share a timestamp with each other and the sort has ties to break
  -- arbitrarily. Leaving two extra rows behind made one of those files draw
  -- the SAME location twice and trip `shipments_distinct_endpoints`.
  --
  -- The fixtures are shared state. A file that adds to them has to put them
  -- back.
  delete from public.locations where id in (with_town, without_town);
end $$;
