-- Behaviour checks for 0007_collaboration.sql.
--
-- Runs after the shipments and provisioning files and builds on their
-- fixtures: `example-freight` (org A), `rival-haulage` (org B), the shipment
-- `ALPHA-001`, and the party grant between them.

-- ---------------------------------------------------------------------------
-- announcements
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  admin_id uuid := '22222222-2222-2222-2222-222222222222';
begin
  perform public.assert_rejects(
    format(
      'insert into public.announcements (org_id, title, body, posted_by) values (%L, %L, %L, %L)',
      org_a, '   ', 'Body', admin_id
    ),
    'an announcement with a blank title is rejected'
  );

  perform public.assert_rejects(
    format(
      'insert into public.announcements (org_id, title, body, posted_by, published_at, expires_at)
       values (%L, %L, %L, %L, now(), now() - interval ''1 day'')',
      org_a, 'Backwards', 'Body', admin_id
    ),
    'an announcement cannot expire before it is published'
  );

  perform public.assert_rejects(
    format(
      'insert into public.announcements (org_id, title, body, posted_by, retracted_at)
       values (%L, %L, %L, %L, now())',
      org_a, 'Half retracted', 'Body', admin_id
    ),
    'a retraction without a retractor is rejected'
  );

  insert into public.announcements (org_id, title, body, posted_by)
  values (org_a, 'Limited staff tomorrow', 'Maintenance on the yard.', admin_id);

  perform public.assert(
    (select count(*) from public.announcements where org_id = org_a) = 1,
    'a well-formed announcement is accepted'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  org_b    uuid := (select id from public.organisations where slug = 'rival-haulage');
  admin_id uuid := '22222222-2222-2222-2222-222222222222';
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  ship     uuid := (select id from public.shipments where reference = 'ALPHA-001');
  stranger uuid;
begin
  -- A third organisation, party to nothing. Without one, the
  -- "sender is a participant" check would be exercised with a NULL sender and
  -- would pass because of the NOT NULL constraint instead.
  insert into public.organisations (name, slug, is_subscriber, created_by)
  values ('Stranger Freight', 'stranger-freight', true, owner_id)
  returning id into stranger;
  -- An org-wide internal message: no shipment, no counterparty.
  insert into public.messages (org_id, sender_org_id, sender_user_id, body)
  values (org_a, org_a, admin_id, 'Yard closes early on Friday.');

  perform public.assert(
    (select count(*) from public.messages where shipment_id is null) = 1,
    'an organisation-wide message needs no shipment — the composite FK is MATCH SIMPLE'
  );

  perform public.assert_rejects(
    format(
      'insert into public.messages (org_id, counterparty_org_id, sender_org_id, sender_user_id, body)
       values (%L, %L, %L, %L, %L)',
      org_a, org_b, org_a, admin_id, 'Broadcast to a counterparty'
    ),
    'a message to a counterparty must name a shipment'
  );

  perform public.assert_rejects(
    format(
      'insert into public.messages (org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body)
       values (%L, %L, %L, %L, %L, %L)',
      org_a, ship, org_a, org_a, admin_id, 'Counterparty is myself'
    ),
    'an organisation cannot be its own counterparty'
  );

  perform public.assert_rejects(
    format(
      'insert into public.messages (org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body)
       values (%L, %L, %L, %L, %L, %L)',
      org_a, ship, org_b, stranger, admin_id, 'Sender is a stranger'
    ),
    'a sender must be one of the two parties to the conversation'
  );

  perform public.assert_rejects(
    format(
      'insert into public.messages (org_id, sender_org_id, sender_user_id, body) values (%L, %L, %L, %L)',
      org_a, org_a, admin_id, '   '
    ),
    'an empty message body is rejected'
  );

  perform public.assert_rejects(
    format(
      'insert into public.messages (org_id, sender_org_id, sender_user_id, body) values (%L, %L, %L, %L)',
      org_a, org_a, admin_id, repeat('x', 4001)
    ),
    'a message over 4000 characters is rejected'
  );

  perform public.assert_rejects(
    format(
      'insert into public.messages (org_id, sender_org_id, sender_user_id, body, retracted_at)
       values (%L, %L, %L, %L, now())',
      org_a, org_a, admin_id, 'Half retracted'
    ),
    'a message retraction without a retractor is rejected'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------

do $$
declare
  org_a       uuid := (select id from public.organisations where slug = 'example-freight');
  org_b       uuid := (select id from public.organisations where slug = 'rival-haulage');
  admin_id    uuid := '22222222-2222-2222-2222-222222222222';
  operator_id uuid := '33333333-3333-3333-3333-333333333333';
  outsider    uuid := '77777777-7777-7777-7777-777777777777';
  task_id     uuid;
begin
  -- The cross-tenant path the guard closes.
  perform public.assert_rejects(
    format(
      'insert into public.tasks (org_id, title, assigned_to, assigned_by, created_by)
       values (%L, %L, %L, %L, %L)',
      org_a, 'Assigned to a stranger', outsider, admin_id, admin_id
    ),
    'a task cannot be assigned to someone outside the organisation'
  );

  -- As a real signed-in user, which is how every completion happens in the
  -- product.
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  insert into public.tasks (org_id, title, assigned_to, assigned_by, created_by)
  values (org_a, 'Chase the Durban POD', operator_id, admin_id, admin_id)
  returning id into task_id;

  perform public.assert(
    (select completed_at from public.tasks where id = task_id) is null,
    'a new task is not complete'
  );

  -- The stamp is the database's, not the caller's.
  update public.tasks
  set status = 'done', completed_at = timestamptz '2000-01-01 00:00:00+02'
  where id = task_id;

  perform public.assert(
    (select completed_at from public.tasks where id = task_id)
      <> timestamptz '2000-01-01 00:00:00+02',
    'a caller cannot dictate when a task was completed'
  );
  perform public.assert(
    (select completed_by from public.tasks where id = task_id) = admin_id,
    'completion records who did it, from the session rather than the request'
  );

  -- Supplying a completer on a task that is not done does not fail — the
  -- trigger normalises it away before the constraint sees the row. That is
  -- the right order: the caller gets a task, not a constraint name. The
  -- constraint remains as a backstop for any path that bypasses the trigger.
  declare stray uuid;
  begin
    insert into public.tasks (org_id, title, assigned_by, created_by, completed_by)
    values (org_a, 'Completer with no completion', admin_id, admin_id, admin_id)
    returning id into stray;

    perform public.assert(
      (select completed_by from public.tasks where id = stray) is null
        and (select completed_at from public.tasks where id = stray) is null,
      'a completer supplied on an unfinished task is ignored, not stored'
    );
  end;

  -- Reopening must not leave it looking finished.
  update public.tasks set status = 'in_progress' where id = task_id;
  perform public.assert(
    (select completed_at from public.tasks where id = task_id) is null
      and (select completed_by from public.tasks where id = task_id) is null,
    'reopening a task clears its completion'
  );

  perform set_config('request.jwt.claim.sub', '', true);

  perform public.assert_rejects(
    format(
      'insert into public.tasks (org_id, shipment_id, title, assigned_by, created_by)
       values (%L, (select id from public.shipments where reference = ''ALPHA-001''), %L, %L, %L)',
      org_b, 'Shipment from another tenant', admin_id, admin_id
    ),
    'a task cannot attach to another organisation''s shipment'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Column privileges
-- ---------------------------------------------------------------------------
-- RLS filters rows; it cannot say "you may retract this but not rewrite it".

do $$
begin
  perform public.assert(
    not has_column_privilege('authenticated', 'public.messages', 'body', 'update'),
    'a message body is immutable — correspondence is retracted, not edited'
  );
  perform public.assert(
    not has_column_privilege('authenticated', 'public.messages', 'org_id', 'update'),
    'a message cannot be moved to another organisation'
  );
  perform public.assert(
    has_column_privilege('authenticated', 'public.messages', 'retracted_at', 'update'),
    'a message can be retracted'
  );

  perform public.assert(
    not has_column_privilege('authenticated', 'public.tasks', 'org_id', 'update'),
    'a task cannot be moved to another organisation'
  );
  perform public.assert(
    has_column_privilege('authenticated', 'public.tasks', 'status', 'update'),
    'a task status can be changed'
  );

  perform public.assert(
    not has_column_privilege('authenticated', 'public.announcements', 'org_id', 'update'),
    'an announcement cannot be moved to another organisation'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Policy shape
-- ---------------------------------------------------------------------------

do $$
declare
  target text;
begin
  foreach target in array array['announcements', 'messages', 'tasks'] loop
    perform public.assert(
      not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = target
          and cmd in ('DELETE', 'ALL')
      ),
      format('%s has no delete policy — things are retracted or cancelled', target)
    );
  end loop;

  -- THE ONE TABLE THE PLATFORM OWNER IS LOCKED OUT OF.
  --
  -- Without this assertion, the day somebody adds `or is_platform_admin()`
  -- "for consistency with every other table", the platform owner silently
  -- gains read access to every conversation between every customer and their
  -- customers. That is a different kind of product.
  perform public.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'messages'
        and (coalesce(qual, '') like '%is_platform_admin%'
             or coalesce(with_check, '') like '%is_platform_admin%')
    ),
    'no messages policy grants the platform owner access to customer correspondence'
  );

  perform public.assert(
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'shipment_parties'
        and column_name = 'messaging_enabled' and column_default = 'false'
    ),
    'messaging is off by default on every party grant'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- The task triggers are locked down like every other definer function
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array['tasks_guard_assignee', 'tasks_stamp_completion'] loop
    perform public.assert(
      exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn and p.prosecdef
          and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
      ),
      format('%s is security definer with a pinned search_path', fn)
    );
  end loop;
end;
$$;
