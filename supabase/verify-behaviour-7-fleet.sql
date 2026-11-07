-- Behaviour checks for 0011_fleet.sql.
--
-- Builds on the earlier fixtures: `example-freight` (org A), `rival-haulage`
-- (org B), and the shipment `ALPHA-001`.
--
-- The one that matters most is the cross-tenant check. A composite foreign
-- key `(driver_id, org_id) -> drivers (id, org_id)` is the only thing
-- stopping a shipment pointing at another organisation's driver, and that
-- would leak a person's name to anybody who can read the shipment.

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  org_b    uuid := (select id from public.organisations where slug = 'rival-haulage');
  ship     uuid := (select id from public.shipments where reference = 'ALPHA-001');
  driver_a uuid;
  driver_b uuid;
  truck_a  uuid;
begin
  -- ---------------------------------------------------------------------
  -- Shape
  -- ---------------------------------------------------------------------
  perform public.assert_rejects(
    format('insert into public.drivers (org_id, full_name) values (%L, %L)', org_a, '   '),
    'a driver with a blank name is rejected'
  );

  perform public.assert_rejects(
    format(
      'insert into public.vehicles (org_id, registration, capacity_kg) values (%L, %L, 0)',
      org_a, 'ND 000-000'
    ),
    'a vehicle with zero capacity is rejected — blank means unknown, not nothing'
  );

  insert into public.drivers (org_id, full_name, licence_expiry)
  values (org_a, 'Thabo Nkosi', date '2027-03-31')
  returning id into driver_a;

  insert into public.vehicles (org_id, registration, vehicle_type, capacity_kg)
  values (org_a, 'ND 123-456', 'rigid', 14000)
  returning id into truck_a;

  perform public.assert(
    (select licence_expiry from public.drivers where id = driver_a) = date '2027-03-31',
    'a licence expiry is a day, not an instant'
  );

  -- ---------------------------------------------------------------------
  -- One per organisation, matched the way the index matches
  -- ---------------------------------------------------------------------
  perform public.assert_rejects(
    format('insert into public.drivers (org_id, full_name) values (%L, %L)',
           org_a, '  thabo nkosi '),
    'the same driver in different case and spacing is refused as a duplicate'
  );

  perform public.assert_rejects(
    format('insert into public.vehicles (org_id, registration) values (%L, %L)',
           org_a, 'nd123456'),
    'the same plate written differently is refused as a duplicate'
  );

  -- The other organisation may of course have its own.
  insert into public.drivers (org_id, full_name)
  values (org_b, 'Thabo Nkosi')
  returning id into driver_b;

  perform public.assert(
    (select count(*) from public.drivers where lower(btrim(full_name)) = 'thabo nkosi') = 2,
    'two organisations can each have a driver of the same name'
  );

  -- ---------------------------------------------------------------------
  -- THE CROSS-TENANT CHECK
  -- ---------------------------------------------------------------------
  perform public.assert_rejects(
    format('update public.shipments set driver_id = %L where id = %L', driver_b, ship),
    'a shipment cannot be given another organisation''s driver'
  );

  perform public.assert(
    (select driver_id from public.shipments where id = ship) is null,
    '...and the shipment is left alone'
  );

  -- The organisation's own driver is accepted. The typed name goes on too,
  -- because the point of keeping that column is that it outlives the row the
  -- id points at — and an assertion about it needs it to be there.
  update public.shipments
  set driver_id = driver_a,
      vehicle_id = truck_a,
      driver_name = 'Thabo Nkosi',
      vehicle_registration = 'ND 123-456'
  where id = ship;

  perform public.assert(
    (select driver_id from public.shipments where id = ship) = driver_a,
    'a shipment CAN be given its own organisation''s driver'
  );

  -- ---------------------------------------------------------------------
  -- Archive, never delete — and a deleted driver must not take loads with it
  -- ---------------------------------------------------------------------
  update public.drivers set archived_at = now() where id = driver_a;

  perform public.assert(
    (select driver_id from public.shipments where id = ship) = driver_a,
    'archiving a driver leaves the shipments that name them intact'
  );

  -- NO ACTION, so a driver who has carried a load cannot be deleted at all.
  -- A company tidying its staff list must not be able to delete its own
  -- delivery history as a side effect.
  perform public.assert_rejects(
    format('delete from public.drivers where id = %L', driver_a),
    'a driver who has carried a load cannot be deleted — archive them instead'
  );

  perform public.assert(
    (select count(*) from public.shipments where id = ship) = 1,
    '...and the shipment is untouched'
  );
  perform public.assert(
    (select driver_name from public.shipments where id = ship) is not null,
    '...with the typed name still there as the historical record'
  );

  -- A driver who has carried nothing is an ordinary row and can go.
  declare
    unused uuid;
  begin
    insert into public.drivers (org_id, full_name)
    values (org_a, 'Never Drove') returning id into unused;
    delete from public.drivers where id = unused;
    perform public.assert(
      (select count(*) from public.drivers where id = unused) = 0,
      'a driver with no shipments can be deleted'
    );
  end;
end $$;


-- ---------------------------------------------------------------------------
-- The backfill
-- ---------------------------------------------------------------------------
-- It ran during the migration, against whatever the earlier fixtures had
-- typed. These assert it produced rows that the unique indexes accept and
-- that every shipment with a name got a reference.

do $$
begin
  perform public.assert(
    not exists (
      select 1 from public.shipments s
      where s.driver_name is not null
        and btrim(s.driver_name) <> ''
        and s.driver_id is null
        and exists (
          select 1 from public.drivers d
          where d.org_id = s.org_id
            and lower(btrim(d.full_name)) = lower(btrim(s.driver_name))
        )
    ),
    'every shipment whose driver still exists carries the reference'
  );

  perform public.assert(
    not exists (
      select 1 from public.drivers d1
      join public.drivers d2
        on d1.org_id = d2.org_id
       and d1.id <> d2.id
       and lower(btrim(d1.full_name)) = lower(btrim(d2.full_name))
      where d1.archived_at is null and d2.archived_at is null
    ),
    'the backfill produced no duplicate live drivers'
  );
end $$;


-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------

do $$
begin
  perform public.assert(
    (select count(*) from pg_indexes
      where schemaname = 'public'
        and indexname in ('drivers_org_name_idx', 'vehicles_org_registration_idx')) = 2,
    'both fleet tables enforce one live row per name per organisation'
  );

  -- The keystone. Without `unique (id, org_id)` the composite FK above
  -- cannot exist, and a shipment could point at a foreign driver.
  perform public.assert(
    (select count(*) from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname in ('drivers', 'vehicles')
        and c.contype = 'u'
        and array_length(c.conkey, 1) = 2) = 2,
    'both fleet tables carry the (id, org_id) uniqueness the composite FK needs'
  );

  -- 'a' is NO ACTION. Never 'c' (cascade), which would delete delivery
  -- history, and never 'r' (restrict), which checks immediately and would
  -- abort an organisation delete depending on cascade ordering.
  perform public.assert(
    (select confdeltype from pg_constraint
      where conname = 'shipments_driver_fkey') = 'a',
    'the driver reference is NO ACTION — never cascade, never restrict'
  );
  perform public.assert(
    (select confdeltype from pg_constraint
      where conname = 'shipments_vehicle_fkey') = 'a',
    'the vehicle reference is NO ACTION — never cascade, never restrict'
  );

  -- A party organisation must not be able to read the carrier's staff list.
  perform public.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('drivers', 'vehicles')
        and coalesce(qual, '') like '%can_view_shipment%'
    ),
    'no fleet policy admits a party organisation'
  );
end $$;
