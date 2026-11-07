-- Behaviour checks for 0010_guard_cascade.sql.
--
-- Two rules that pull against each other, and both have to hold:
--
--   an organisation that STAYS may never lose its last admin
--   an organisation that is being DELETED may take its members with it
--
-- Before 0010 the first rule swallowed the second, and `delete from
-- organisations` failed for every organisation that had an admin.

do $$
declare
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  doomed   uuid;
  member_a uuid := 'aaaa0000-0000-0000-0000-00000000000a';
  member_b uuid := 'bbbb0000-0000-0000-0000-00000000000b';
begin
  insert into auth.users (id, email) values
    (member_a, 'cascade-a@verify.test'),
    (member_b, 'cascade-b@verify.test');

  insert into public.organisations (name, slug, is_subscriber, created_by)
  values ('Cascade Freight', 'cascade-freight', true, owner_id)
  returning id into doomed;

  insert into public.memberships (org_id, user_id, role) values
    (doomed, member_a, 'admin'),
    (doomed, member_b, 'operator');

  -- The rule that must survive: while the organisation stays, its last admin
  -- cannot be removed.
  perform public.assert_rejects(
    format('delete from public.memberships where org_id = %L and user_id = %L',
           doomed, member_a),
    'the last admin of a surviving organisation still cannot be removed'
  );

  perform public.assert_rejects(
    format('update public.memberships set role = ''viewer''
            where org_id = %L and user_id = %L', doomed, member_a),
    'the last admin of a surviving organisation still cannot be demoted'
  );

  -- An operator may go; they were never the last admin.
  delete from public.memberships where org_id = doomed and user_id = member_b;

  perform public.assert(
    (select count(*) from public.memberships where org_id = doomed) = 1,
    'a non-admin member can still be removed'
  );

  -- THE FIX. Before 0010 this raised check_violation from the cascade, and
  -- `organisations_delete_platform` was therefore unusable from the day it
  -- was written.
  delete from public.organisations where id = doomed;

  perform public.assert(
    (select count(*) from public.organisations where id = doomed) = 0,
    'an organisation WITH an admin can be deleted'
  );

  perform public.assert(
    (select count(*) from public.memberships where org_id = doomed) = 0,
    '...and its memberships go with it'
  );
end $$;

-- The full cascade, with everything an organisation owns hanging off it —
-- which is the shape the demo data actually has.
do $$
declare
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  admin_id uuid := '22222222-2222-2222-2222-222222222222';
  org      uuid;
  loc_a    uuid;
  loc_b    uuid;
  ship     uuid;
begin
  insert into public.organisations (name, slug, is_subscriber, created_by)
  values ('Loaded Freight', 'loaded-freight', true, owner_id)
  returning id into org;

  insert into public.memberships (org_id, user_id, role)
  values (org, admin_id, 'admin');

  insert into public.locations (org_id, name, kind, sa_place_id)
  select org, 'Loaded Depot', 'depot', id
  from public.sa_places where slug = 'johannesburg'
  returning id into loc_a;

  insert into public.locations (org_id, name, kind, sa_place_id)
  select org, 'Loaded Site', 'customer_site', id
  from public.sa_places where slug = 'durban'
  returning id into loc_b;

  insert into public.shipments
    (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org, 'LOADED-001', loc_a, loc_b, owner_id)
  returning id into ship;

  insert into public.checkpoints
    (org_id, shipment_id, sequence_no, kind, label, actual_at)
  values (org, ship, 100, 'pickup', 'Collected', now());

  insert into public.tasks (org_id, shipment_id, title, assigned_by, created_by)
  values (org, ship, 'Chase the POD', admin_id, admin_id);

  insert into public.announcements (org_id, title, body, posted_by)
  values (org, 'Notice', 'Body', admin_id);

  delete from public.organisations where id = org;

  perform public.assert(
    (select count(*) from public.shipments where org_id = org) = 0,
    'deleting an organisation takes its shipments'
  );
  perform public.assert(
    (select count(*) from public.checkpoints where org_id = org) = 0,
    '...its checkpoints'
  );
  perform public.assert(
    (select count(*) from public.locations where org_id = org) = 0,
    '...its places'
  );
  perform public.assert(
    (select count(*) from public.tasks where org_id = org) = 0,
    '...its tasks'
  );
  perform public.assert(
    (select count(*) from public.announcements where org_id = org) = 0,
    '...and its notices'
  );

  -- The gazetteer is shared reference data, not the tenant's. It must not
  -- move when a tenant goes.
  perform public.assert(
    (select count(*) from public.sa_places) = 521,
    'the shared gazetteer is untouched by a tenant being deleted'
  );
end $$;
