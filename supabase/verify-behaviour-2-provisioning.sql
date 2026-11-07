-- Behaviour checks for 0006_provisioning.sql.
--
-- Runs after verify-behaviour.sql and verify-behaviour-shipments.sql, and
-- builds on their fixtures.

-- ---------------------------------------------------------------------------
-- The two new definer functions are locked down
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array['org_members', 'claim_invitations'] loop
    perform public.assert(
      exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn and p.prosecdef
          and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
      ),
      format('%s is security definer with a pinned search_path', fn)
    );

    perform public.assert(
      not has_function_privilege('anon', (
        select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn limit 1
      ), 'execute'),
      format('%s is not executable by anon', fn)
    );

    perform public.assert(
      has_function_privilege('authenticated', (
        select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn limit 1
      ), 'execute'),
      format('%s is executable by authenticated', fn)
    );
  end loop;

  -- org_members takes an ORGANISATION, never a user id. A function that took
  -- a user id would be an oracle any caller could query about anybody.
  perform public.assert(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'org_members'
       and p.pronargs = 1) = 1,
    'org_members takes exactly one argument, the organisation'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- claim_invitations only ever claims the caller's own invitations
-- ---------------------------------------------------------------------------
-- The gap it closes: handle_new_user fires once, at signup. Somebody invited
-- to a second organisation months later would otherwise sit on /no-access
-- with a pending invitation that nothing will ever action.

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  org_b    uuid := (select id from public.organisations where slug = 'rival-haulage');
  admin_id uuid := '22222222-2222-2222-2222-222222222222';
  existing uuid := '88888888-8888-8888-8888-888888888888';
  claimed  integer;
begin
  -- A user who already exists, with no membership in org B.
  insert into auth.users (id, email) values (existing, 'existing@example.test');

  perform public.assert(
    not exists (select 1 from public.memberships where user_id = existing),
    'the existing user starts with no membership'
  );

  insert into public.invitations (org_id, email, role, invited_by)
  values (org_b, 'existing@example.test', 'operator', admin_id);

  -- Nothing happens on its own: the signup trigger already fired for them.
  perform public.assert(
    not exists (select 1 from public.memberships where user_id = existing),
    'an invitation to an existing user does not grant membership by itself'
  );

  -- Claiming as somebody else must do nothing at all.
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  select public.claim_invitations() into claimed;
  perform public.assert(
    claimed = 0
      and not exists (select 1 from public.memberships where user_id = existing),
    'another user cannot claim an invitation addressed to someone else'
  );

  -- Claiming as the invitee works.
  perform set_config('request.jwt.claim.sub', existing::text, true);
  select public.claim_invitations() into claimed;

  perform public.assert(claimed = 1, 'the invitee claims exactly one invitation');
  perform public.assert(
    exists (
      select 1 from public.memberships
      where user_id = existing and org_id = org_b and role = 'operator'
    ),
    'claiming an invitation grants the role it specified'
  );
  perform public.assert(
    (select accepted_by from public.invitations
     where email = 'existing@example.test') = existing,
    'the claimed invitation is stamped accepted_by'
  );

  -- Claiming twice must not duplicate anything.
  select public.claim_invitations() into claimed;
  perform public.assert(
    claimed = 0
      and (select count(*) from public.memberships where user_id = existing) = 1,
    'claiming twice is harmless'
  );

  -- A revoked invitation is never claimable.
  insert into public.invitations (org_id, email, role, invited_by, revoked_at, revoked_by)
  values (org_a, 'existing@example.test', 'admin', admin_id, now(), admin_id);

  select public.claim_invitations() into claimed;
  perform public.assert(
    claimed = 0
      and not exists (
        select 1 from public.memberships where user_id = existing and org_id = org_a
      ),
    'a revoked invitation cannot be claimed'
  );

  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;


-- ---------------------------------------------------------------------------
-- org_members refuses anyone who is not an admin of that organisation
-- ---------------------------------------------------------------------------

do $$
declare
  org_a       uuid := (select id from public.organisations where slug = 'example-freight');
  admin_id    uuid := '22222222-2222-2222-2222-222222222222';
  operator_id uuid := '33333333-3333-3333-3333-333333333333';
  outsider    uuid := '77777777-7777-7777-7777-777777777777';
  n           integer;
begin
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  select count(*) into n from public.org_members(org_a);
  perform public.assert(n >= 2, 'an org admin can list their own members');

  perform set_config('request.jwt.claim.sub', operator_id::text, true);
  perform public.assert_rejects(
    format('select * from public.org_members(%L)', org_a),
    'an operator cannot list members'
  );

  perform set_config('request.jwt.claim.sub', outsider::text, true);
  perform public.assert_rejects(
    format('select * from public.org_members(%L)', org_a),
    'an outsider cannot list members of an organisation they are not in'
  );

  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
