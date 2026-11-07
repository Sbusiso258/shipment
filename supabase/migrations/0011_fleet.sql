-- 0011_fleet.sql — drivers and vehicles become things, not strings.
--
-- `shipments.driver_name` and `shipments.vehicle_registration` have been free
-- text since 0004. That was right while a shipment was the only noun in the
-- product: a driver was a label on a load, not something you managed.
--
-- It stops being right the moment anybody asks "which loads is Thabo on this
-- week" or "when is ND 123-456 due for a service". Free text cannot answer
-- either, because `Thabo Nkosi`, `T Nkosi` and `thabo nkosi ` are three
-- drivers, and a licence expiry has nowhere to live.
--
-- WHAT THIS DOES NOT DO: drop the two text columns. They hold real data on
-- rows that already exist, migrations here are forward-only, and the backfill
-- below cannot be certain that two spellings are one person. So the columns
-- stay as the historical record of what was typed, the FKs become what the
-- app reads and writes, and nobody should "tidy away" the former.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- drivers
-- ===========================================================================
-- Shaped on `locations` (0002) deliberately: same tenancy, same archive-rather
-- -than-delete, same policy set. A reader who knows one knows both.

create table public.drivers (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,

  full_name text not null check (length(btrim(full_name)) between 1 and 160),
  phone     text,

  licence_number text,
  licence_class  text,

  -- A `date`, and the second one in the schema after `promised_delivery_date`.
  -- Non-negotiable #10 reserves `date` for a day a human is held to, and a
  -- licence expires at the end of a day in the operator's own zone — not at
  -- 02:00 local when a UTC instant happens to roll over.
  licence_expiry date,

  notes       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- THE KEYSTONE, same as on `locations`. It lets `shipments` prove through
  -- one composite foreign key that a driver belongs to the same organisation
  -- as the load. Without it a shipment could point at another tenant's
  -- driver, which would leak that person's name to anybody who can read the
  -- shipment.
  unique (id, org_id)
);

-- One live driver per name per organisation. Archived ones are excluded, so
-- somebody who leaves and returns gets their row back rather than a clash.
create unique index drivers_org_name_idx
  on public.drivers (org_id, lower(btrim(full_name)))
  where archived_at is null;

create index drivers_org_idx on public.drivers (org_id) where archived_at is null;

create trigger drivers_set_updated_at
  before update on public.drivers
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- vehicles
-- ===========================================================================

create type public.vehicle_type as enum (
  'rigid', 'tractor', 'trailer', 'bakkie', 'van', 'other'
);

create table public.vehicles (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,

  registration text not null check (length(btrim(registration)) between 1 and 32),
  make         text,
  model        text,
  vehicle_type public.vehicle_type not null default 'other',

  -- `numeric`, never float, and the same precision as `shipments.weight_kg`
  -- so the two can be compared without a cast deciding the answer.
  capacity_kg numeric(12,3) check (capacity_kg is null or capacity_kg > 0),

  -- A day, for the same reason as `licence_expiry`.
  service_due date,

  notes       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (id, org_id)
);

-- Registrations are written down inconsistently — `ND 123-456`, `nd123456` —
-- so the uniqueness is on the stripped, folded form. Two spellings of one
-- plate are one vehicle.
create unique index vehicles_org_registration_idx
  on public.vehicles (org_id, upper(regexp_replace(registration, '[^A-Za-z0-9]', '', 'g')))
  where archived_at is null;

create index vehicles_org_idx on public.vehicles (org_id) where archived_at is null;

create trigger vehicles_set_updated_at
  before update on public.vehicles
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- shipments gains two references
-- ===========================================================================
-- Nullable, because a load can be recorded before anyone is assigned to drive
-- it, and because every existing row has no driver_id until the backfill runs.

alter table public.shipments
  add column driver_id  uuid,
  add column vehicle_id uuid;

alter table public.shipments
  add constraint shipments_driver_fkey
    foreign key (driver_id, org_id)
    references public.drivers (id, org_id) on delete no action,
  add constraint shipments_vehicle_fkey
    foreign key (vehicle_id, org_id)
    references public.vehicles (id, org_id) on delete no action;

-- `NO ACTION`, and the two alternatives are both worse.
--
-- NOT CASCADE: that would delete a company's delivery history because
-- somebody tidied up the staff list. The record of who carried what is the
-- product.
--
-- NOT `SET NULL`: on a COMPOSITE key, plain `set null` nulls EVERY column in
-- the key — including `org_id`, which is `not null`. The delete then fails
-- with "null value in column org_id violates not-null constraint", which
-- names a column nobody touched. Postgres 15 added `set null (driver_id)` to
-- fix exactly this, but pinning the schema to a server version for one
-- clause is a poor trade when NO ACTION says the right thing anyway.
--
-- NOT `RESTRICT`, which looks identical and is not: RESTRICT checks
-- immediately, NO ACTION checks at the END OF THE STATEMENT. Deleting an
-- organisation cascades into `drivers` and `shipments` both, in an order
-- Postgres does not promise — under RESTRICT, drivers going first would
-- abort the whole delete. This is the same trap 0010 had to undo on
-- `memberships_guard_last_admin`, and it is worth recognising on sight.
--
-- What it means in practice: a driver who has carried a load cannot be
-- deleted. Archive them. That is how everything else in this schema ends.

create index shipments_driver_idx on public.shipments (driver_id)
  where driver_id is not null;
create index shipments_vehicle_idx on public.shipments (vehicle_id)
  where vehicle_id is not null;


-- ===========================================================================
-- Backfill
-- ===========================================================================
-- One driver per distinct name per organisation, one vehicle per distinct
-- registration, then point the shipments at them.
--
-- MATCHED THE SAME WAY THE UNIQUE INDEXES MATCH, so the insert cannot produce
-- a row the index would then reject. Names fold on case and surrounding
-- space; registrations strip punctuation.
--
-- This is best-effort by nature: it cannot know that `T Nkosi` and
-- `Thabo Nkosi` are one person. It creates two drivers, and whoever runs the
-- business merges them by archiving one. Guessing would be worse — a
-- shipment reassigned to the wrong driver is a false record, and this product
-- is sold on not having those.

insert into public.drivers (org_id, full_name)
select distinct s.org_id, btrim(s.driver_name)
from public.shipments s
where s.driver_name is not null
  and btrim(s.driver_name) <> ''
on conflict do nothing;

insert into public.vehicles (org_id, registration)
select distinct s.org_id, btrim(s.vehicle_registration)
from public.shipments s
where s.vehicle_registration is not null
  and btrim(s.vehicle_registration) <> ''
on conflict do nothing;

update public.shipments s
set driver_id = d.id
from public.drivers d
where d.org_id = s.org_id
  and lower(btrim(d.full_name)) = lower(btrim(s.driver_name))
  and s.driver_name is not null
  and s.driver_id is null;

update public.shipments s
set vehicle_id = v.id
from public.vehicles v
where v.org_id = s.org_id
  and upper(regexp_replace(v.registration, '[^A-Za-z0-9]', '', 'g'))
    = upper(regexp_replace(s.vehicle_registration, '[^A-Za-z0-9]', '', 'g'))
  and s.vehicle_registration is not null
  and s.vehicle_id is null;


-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Identical in shape to `locations`, and for the same reasons. Every policy
-- scoped `to authenticated`; every UPDATE repeats its `using` as `with check`
-- so an admin cannot move a driver to another tenant.
--
-- DELIBERATELY NOT NARROWED BY ASSIGNMENT, unlike shipment data in 0008. An
-- operator picks a driver and a vehicle when recording a load; a picker that
-- only showed the fleet already on their own shipments would make the first
-- load of a new vehicle impossible to record. Same judgement as `locations`.

alter table public.drivers  enable row level security;
alter table public.vehicles enable row level security;

-- --- drivers ---------------------------------------------------------------
-- NOT widened to party organisations. A consignee watching a load has no
-- business holding the carrier's staff list, their phone numbers or their
-- licence numbers. The shipment carries `driver_name` for display; this table
-- is the employer's record.
create policy drivers_select_member on public.drivers
  for select to authenticated using (
    public.is_org_member(org_id) or public.is_platform_admin()
  );
create policy drivers_insert_staff on public.drivers
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy drivers_update_staff on public.drivers
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy drivers_delete_admin on public.drivers
  for delete to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );

-- --- vehicles --------------------------------------------------------------
create policy vehicles_select_member on public.vehicles
  for select to authenticated using (
    public.is_org_member(org_id) or public.is_platform_admin()
  );
create policy vehicles_insert_staff on public.vehicles
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy vehicles_update_staff on public.vehicles
  for update to authenticated using (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin', 'operator']::public.membership_role[])
  );
create policy vehicles_delete_admin on public.vehicles
  for delete to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );

comment on table public.drivers is
  'The people an organisation puts behind a wheel. shipments.driver_name is '
  'kept as the historical record of what was typed before 0011; driver_id is '
  'what the app reads.';

comment on table public.vehicles is
  'An organisation''s fleet. shipments.vehicle_registration is kept as the '
  'historical record of what was typed before 0011; vehicle_id is what the '
  'app reads.';
