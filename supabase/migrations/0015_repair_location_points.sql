-- 0015_repair_location_points.sql
--
-- REPAIRS SCHEMA DRIFT, and is the first migration in this project written to
-- fix the live database rather than to advance it.
--
-- WHAT WENT WRONG. `public.location_points` is created by `0002_locations.sql`
-- as a VIEW. In the owner's live project it exists as something that is not a
-- view — `pg_get_viewdef()` returns NULL for it while `::regclass` resolves,
-- which is what an ordinary TABLE looks like. An empty one.
--
-- WHAT THAT COST. `listLocations()` reads `location_points`, not `locations`.
-- So the places list returned zero rows while nine real depots sat in
-- `locations`, correctly owned and with `archived_at` null. The product said
-- "None yet. Add the first one below", the owner added nine, and every one of
-- them vanished. `/shipments/new` then refused to render at all, because it
-- requires two places — so this single drifted object made the application
-- look as though it could neither save a place nor create a shipment.
--
-- Proved rather than guessed, as `authenticated` with the owner's JWT claim:
--
--   is_org_member(...)                    true
--   select from public.locations          9 rows
--   select from public.location_points    0 rows
--
-- The policy was never the problem. The relation was.
--
-- WHY A MIGRATION AND NOT A FIX IN THE SQL EDITOR. Non-negotiable 8:
-- migrations are forward-only and numbered. A repair applied only by hand
-- exists in one database and nowhere else — the next project provisioned from
-- this repository would be built correctly from 0002 and would never need it,
-- while any project that drifted the same way would stay broken with no record
-- of why. This file is that record.
--
-- IT IS SAFE ON A CORRECT DATABASE. Where `location_points` is already the
-- view 0002 defines, the DROP removes it and the CREATE puts back an identical
-- definition. `verify:migrations` builds from 0001 and proves exactly that.

-- `drop ... if exists` twice, because the drifted object may be either kind and
-- `drop view` will not remove a table (nor `drop table` a view). Deliberately
-- NOT `cascade`: nothing in this schema depends on this view — no policy, no
-- foreign key, no other view — and a cascade here would quietly take anything
-- that did.
drop view if exists public.location_points;
drop table if exists public.location_points;

-- Byte-for-byte the definition from 0002, including `security_invoker`.
--
-- THAT OPTION IS LOAD-BEARING. Without it the view runs as its owner and
-- bypasses row-level security on `locations` entirely, which would show every
-- tenant's depots to everybody. A view that merely "works again" is not the
-- goal.
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

comment on view public.location_points is
  'Effective coordinates and their provenance. security_invoker, so the '
  'locations policy decides what each caller sees. Recreated by 0015 after '
  'the live project was found holding a table of this name instead.';
