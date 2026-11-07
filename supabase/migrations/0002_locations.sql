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
