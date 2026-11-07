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
