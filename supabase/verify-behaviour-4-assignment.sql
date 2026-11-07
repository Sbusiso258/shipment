-- Behaviour checks for 0008_assignment.sql.
--
-- Runs after the shipments, provisioning and collaboration files and builds on
-- their fixtures: `example-freight` (org A), `rival-haulage` (org B), the
-- shipment `ALPHA-001`, and the admin / operator users.
--
-- WHAT THIS FILE CAN AND CANNOT SEE. It runs as the table owner, so every
-- policy in 0008 is inert here — the narrowing itself is proved in
-- `verify-rls.mjs` and nowhere else. What this file covers is the part
-- `verify:rls` is poor at: the constraints, the triggers and the shape of the
-- table underneath those policies.

-- ---------------------------------------------------------------------------
-- The assignee guard
-- ---------------------------------------------------------------------------

do $$
declare
  org_a       uuid := (select id from public.organisations where slug = 'example-freight');
  org_b       uuid := (select id from public.organisations where slug = 'rival-haulage');
  ship        uuid := (select id from public.shipments where reference = 'ALPHA-001');
  admin_id    uuid := '22222222-2222-2222-2222-222222222222';
  operator_id uuid := '33333333-3333-3333-3333-333333333333';
  outsider    uuid := '66666666-6666-6666-6666-666666666666';
begin
  -- An assignment IS a read grant, so this is the guard that stops an admin
  -- handing their shipments to anybody whose user id they can name.
  perform public.assert_rejects(
    format(
      'insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
       values (%L, %L, %L, %L)',
      org_a, ship, outsider, admin_id
    ),
    'a shipment cannot be assigned to someone outside the organisation'
  );

  perform public.assert_rejects(
    format(
      'insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
       values (%L, %L, %L, %L)',
      org_b, ship, operator_id, admin_id
    ),
    'an assignment cannot name an organisation that does not own the shipment'
  );

  perform public.assert_rejects(
    format(
      'insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by, unassigned_by)
       values (%L, %L, %L, %L, %L)',
      org_a, ship, operator_id, admin_id, admin_id
    ),
    'an unassigner without an unassignment time is rejected'
  );

  perform public.assert_rejects(
    format(
      'insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by, note)
       values (%L, %L, %L, %L, %L)',
      org_a, ship, operator_id, admin_id, '   '
    ),
    'a blank assignment note is rejected'
  );

  -- The positive path.
  insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
  values (org_a, ship, operator_id, admin_id);

  perform public.assert(
    (select count(*) from public.shipment_assignments
      where shipment_id = ship and user_id = operator_id and unassigned_at is null) = 1,
    'an operator can be assigned to a shipment in their own organisation'
  );

  perform public.assert_rejects(
    format(
      'insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
       values (%L, %L, %L, %L)',
      org_a, ship, operator_id, admin_id
    ),
    'the same person cannot hold two live assignments on one shipment'
  );
end $$;


-- ---------------------------------------------------------------------------
-- Unassignment is stamped, and is a spell rather than a mutable row
-- ---------------------------------------------------------------------------

do $$
declare
  org_a       uuid := (select id from public.organisations where slug = 'example-freight');
  ship        uuid := (select id from public.shipments where reference = 'ALPHA-001');
  admin_id    uuid := '22222222-2222-2222-2222-222222222222';
  operator_id uuid := '33333333-3333-3333-3333-333333333333';
  row_id      uuid;
  first_end   timestamptz;
begin
  select id into row_id from public.shipment_assignments
   where shipment_id = ship and user_id = operator_id and unassigned_at is null;

  -- A SECOND PERSON ON THE LOAD, because 0012 added the coverage guard: an
  -- active shipment may not lose its LAST operator. These checks are about
  -- how an unassignment is stamped, not about coverage, so they need somebody
  -- else on it first. The guard itself is exercised in
  -- verify-behaviour-8-audit.sql.
  insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
  values (org_a, ship, admin_id, admin_id);

  -- The caller names a time of their choosing; the database overrules it, the
  -- same way a checkpoint's `recorded_at` is overruled.
  update public.shipment_assignments
     set unassigned_at = timestamptz '1999-01-01 00:00:00+02'
   where id = row_id;

  select unassigned_at into first_end
    from public.shipment_assignments where id = row_id;

  perform public.assert(
    first_end > now() - interval '1 minute',
    'the end of an assignment is stamped by the database, not by the caller'
  );

  -- `auth.uid()` is null in this session, so there is no unassigner to record.
  -- "Ended, by someone unknown" is a real state; the constraint permits it and
  -- the one-directional check is why.
  perform public.assert(
    (select unassigned_by is null from public.shipment_assignments where id = row_id),
    'an unassignment outside a user session records no unassigner'
  );

  update public.shipment_assignments
     set unassigned_at = timestamptz '2001-01-01 00:00:00+02'
   where id = row_id;

  perform public.assert(
    (select unassigned_at from public.shipment_assignments where id = row_id) = first_end,
    'a finished assignment keeps its original end, ignoring a later caller'
  );

  update public.shipment_assignments set unassigned_at = null where id = row_id;

  perform public.assert(
    (select unassigned_at from public.shipment_assignments where id = row_id) = first_end,
    'a finished assignment cannot be reopened in place — it stays finished'
  );

  -- ...and the partial unique index therefore lets the same person be assigned
  -- again, as a second spell. This is the whole reason history is a row rather
  -- than a nullable column.
  insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
  values (org_a, ship, operator_id, admin_id);

  perform public.assert(
    (select count(*) from public.shipment_assignments
      where shipment_id = ship and user_id = operator_id) = 2,
    'a person reassigned after being taken off gets a second spell, not an edit'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The creator trigger
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  loc_a1   uuid := (select id from public.locations where org_id = org_a order by created_at limit 1);
  loc_a2   uuid := (select id from public.locations where org_id = org_a order by created_at offset 1 limit 1);
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  ship     uuid;
begin
  insert into public.shipments (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org_a, 'ALPHA-NOSESSION', loc_a1, loc_a2, owner_id)
  returning id into ship;

  -- There is no `auth.uid()` here, so there is nobody at a keyboard to assign.
  -- Writing `created_by` in instead would put a name against work that person
  -- did not do.
  perform public.assert(
    (select count(*) from public.shipment_assignments where shipment_id = ship) = 0,
    'a shipment created outside a user session assigns nobody'
  );
end $$;


-- ---------------------------------------------------------------------------
-- Cascades and structure
-- ---------------------------------------------------------------------------

do $$
declare
  org_a       uuid := (select id from public.organisations where slug = 'example-freight');
  loc_a1      uuid := (select id from public.locations where org_id = org_a order by created_at limit 1);
  loc_a2      uuid := (select id from public.locations where org_id = org_a order by created_at offset 1 limit 1);
  admin_id    uuid := '22222222-2222-2222-2222-222222222222';
  operator_id uuid := '33333333-3333-3333-3333-333333333333';
  owner_id    uuid := '11111111-1111-1111-1111-111111111111';
  doomed      uuid;
begin
  insert into public.shipments (org_id, reference, origin_location_id, destination_location_id, created_by)
  values (org_a, 'ALPHA-DOOMED', loc_a1, loc_a2, owner_id)
  returning id into doomed;

  insert into public.shipment_assignments (org_id, shipment_id, user_id, assigned_by)
  values (org_a, doomed, operator_id, admin_id);

  delete from public.shipments where id = doomed;

  perform public.assert(
    (select count(*) from public.shipment_assignments where shipment_id = doomed) = 0,
    'deleting a shipment takes its assignments with it'
  );
end $$;

do $$
begin
  -- The index the whole narrowing rests on. Without it every policy
  -- evaluation on five tables sequentially scans this table.
  perform public.assert(
    exists (
      select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'shipment_assignments_user_idx'
    ),
    'the per-user assignment lookup index exists'
  );

  perform public.assert(
    exists (
      select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'shipment_assignments_active_idx'
    ),
    'one live assignment per person per shipment is enforced by a unique index'
  );

  -- Assignments end; they are not removed. Same discipline as party grants,
  -- invitations and tasks.
  perform public.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'shipment_assignments' and cmd = 'DELETE'
    ),
    'shipment_assignments has no delete policy — assignments end, they do not vanish'
  );

  -- Column privileges, not RLS, are what stop an admin moving a live
  -- assignment onto another shipment. RLS cannot express "this column only".
  perform public.assert(
    not exists (
      select 1 from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'shipment_assignments'
        and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
        and column_name in ('org_id', 'shipment_id', 'user_id', 'assigned_by')
    ),
    'an assignment cannot be moved to another shipment, person or tenant by update'
  );

  perform public.assert(
    (select count(*) from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'shipment_assignments'
        and grantee = 'authenticated'
        and privilege_type = 'UPDATE') = 3,
    'only unassigned_at, unassigned_by and note are updatable'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The predicates
-- ---------------------------------------------------------------------------
-- These two functions bypass RLS. The five rules in 0001 are what make that
-- safe, and three of them are machine-checkable.

do $$
declare
  fn text;
begin
  foreach fn in array array['is_assigned_to_shipment', 'can_view_shipment']
  loop
    perform public.assert(
      (select p.prosecdef from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn),
      format('%s is security definer', fn)
    );

    perform public.assert(
      (select p.proconfig @> array['search_path=public'] from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn),
      format('%s pins its search_path', fn)
    );

    perform public.assert(
      (select p.provolatile = 's' from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn),
      format('%s is stable, so a policy evaluates it once per statement', fn)
    );

    -- Rule 4, the one that would be worst to get wrong: a user-id parameter
    -- would make the function an oracle any caller could query about anybody.
    perform public.assert(
      (select p.pronargs = 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn),
      format('%s takes no user id — it reads auth.uid() itself', fn)
    );
  end loop;
end $$;

do $$
begin
  -- The narrowing is only real if the branch it replaced is gone. A policy
  -- left reading `is_org_member(org_id)` on shipment data would make the whole
  -- migration inert for that table, silently and in the leaking direction.
  perform public.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('shipments', 'checkpoints')
        and cmd = 'SELECT'
        and qual like '%is_org_member%'
    ),
    'no SELECT policy on shipment data still admits every member of the org'
  );

  perform public.assert(
    (select count(*) from pg_policies
      where schemaname = 'public'
        and tablename in ('shipments', 'checkpoints')
        and cmd = 'SELECT') = 1 + 1,
    'shipments and checkpoints have exactly one SELECT policy each'
  );

  -- Writes follow reads. A read restriction with the write policies left
  -- alone is not a restriction — it is an invisible edit.
  perform public.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('shipments', 'checkpoints')
        and cmd in ('UPDATE', 'INSERT')
        and coalesce(qual, '') || coalesce(with_check, '') not like '%can_view_shipment%'
        and tablename || cmd <> 'shipmentsINSERT'
    ),
    'every shipment and checkpoint write policy requires sight of the shipment'
  );

  -- 0007 locked the platform owner out of customer correspondence. Rewriting
  -- the messages policies here is exactly the kind of change that would put
  -- them back in "for consistency".
  perform public.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'messages'
        and coalesce(qual, '') || coalesce(with_check, '') like '%is_platform_admin%'
    ),
    'rewriting the messages policies did not let the platform owner back in'
  );
end $$;
