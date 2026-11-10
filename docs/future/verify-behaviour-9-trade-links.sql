-- Behaviour checks for 0014_trade_links.sql.
--
-- NAMING: `verify-migrations.mjs` sorts these files LEXICALLY, so a file
-- named `-10-` would run before `-2-`. This is the ninth, so `-9-` is still
-- safe; from ten onward the numbers must be zero-padded.

-- ---------------------------------------------------------------------------
-- The shape of a link
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  org_b    uuid := (select id from public.organisations where slug = 'bravo-logistics');
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  link     uuid;
begin
  perform public.assert_rejects(
    format('insert into public.trade_links
              (org_id, counterparty_org_id, party_role, created_by)
            values (%L, %L, %L, %L)', org_a, org_a, 'consignor', owner_id),
    'an organisation cannot link to itself'
  );

  insert into public.trade_links
    (org_id, counterparty_org_id, party_role, created_by)
  values (org_a, org_b, 'consignor', owner_id)
  returning id into link;

  -- One live link per counterparty per role.
  perform public.assert_rejects(
    format('insert into public.trade_links
              (org_id, counterparty_org_id, party_role, created_by)
            values (%L, %L, %L, %L)', org_a, org_b, 'consignor', owner_id),
    'the same counterparty cannot be linked twice in the same role'
  );

  -- A DIFFERENT ROLE IS A DIFFERENT RELATIONSHIP. A wholesaler who both
  -- ships to and receives from one carrier holds two links.
  insert into public.trade_links
    (org_id, counterparty_org_id, party_role, created_by)
  values (org_a, org_b, 'consignee', owner_id);

  perform public.assert(
    (select count(*) from public.trade_links
      where org_id = org_a and counterparty_org_id = org_b
        and revoked_at is null) = 2,
    'the same counterparty CAN be linked in two different roles'
  );

  -- "Revoked by somebody unknown" is real, because auth.uid() is null outside
  -- a user session. "Revoked by somebody at no time" is not.
  perform public.assert_rejects(
    format('update public.trade_links set revoked_by = %L where id = %L',
           owner_id, link),
    'a revoker without a revocation time is refused'
  );

  update public.trade_links set revoked_at = now() where id = link;

  -- ...and re-linking after revocation is a NEW ROW, so the history reads as
  -- a sequence of spells rather than one mutable row.
  insert into public.trade_links
    (org_id, counterparty_org_id, party_role, created_by)
  values (org_a, org_b, 'consignor', owner_id);

  perform public.assert(
    (select count(*) from public.trade_links
      where org_id = org_a and counterparty_org_id = org_b
        and party_role = 'consignor') = 2,
    'a revoked link can be replaced, and both spells are kept'
  );

  perform public.assert_rejects(
    'insert into public.trade_links
       (org_id, counterparty_org_id, party_role, created_by, reference)
     values ((select id from public.organisations where slug = ''example-freight''),
             (select id from public.organisations where slug = ''bravo-logistics''),
             ''broker'', ''11111111-1111-1111-1111-111111111111'', ''   '')',
    'a blank reference is refused — blank means unknown, not a name'
  );
end $$;


-- ---------------------------------------------------------------------------
-- A link cannot be moved, only revoked
-- ---------------------------------------------------------------------------

do $$
begin
  -- THE COLUMN LIST IS THE REAL RULE. `with check` only inspects `org_id`,
  -- which stays true after an admin rewrites `counterparty_org_id` — so
  -- without the revoke, an admin could point an existing link at a different
  -- organisation and inherit whatever it permits.
  perform public.assert(
    not has_column_privilege('authenticated', 'public.trade_links',
                             'counterparty_org_id', 'update'),
    'the counterparty on a link cannot be changed by the application'
  );
  perform public.assert(
    not has_column_privilege('authenticated', 'public.trade_links',
                             'org_id', 'update'),
    '...and neither can the transporter'
  );
  perform public.assert(
    not has_column_privilege('authenticated', 'public.trade_links',
                             'party_role', 'update'),
    '...nor the role, which would silently change what the link permits'
  );
  perform public.assert(
    has_column_privilege('authenticated', 'public.trade_links',
                         'revoked_at', 'update'),
    'revoking a link IS permitted'
  );

  -- Revocation is a timestamp. A deleted link would take the record of the
  -- relationship with it.
  perform public.assert(
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'trade_links'
        and cmd in ('DELETE', 'ALL')) = 0,
    'there is no way to delete a link'
  );

  -- The structural sweeps in verify-behaviour.sql cover RLS-enabled and
  -- using/with-check. This one is specific: both sides must be able to read.
  perform public.assert(
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'trade_links'
        and cmd = 'SELECT') = 1,
    'links have exactly one read policy'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The counterparty name lookup
-- ---------------------------------------------------------------------------

do $$
declare
  org_a uuid := (select id from public.organisations where slug = 'example-freight');
  org_d uuid := (select id from public.organisations where slug = 'delta-distribution');
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  link  uuid;
begin
  -- `shares_shipment_with_org` is how `organisations_select_counterparty`
  -- decides whether one organisation may read another's NAME. Before 0014 a
  -- freshly linked sender could not, so their first screen would have
  -- rendered uuids.
  --
  -- The function reads `my_org_ids()`, which is empty outside a user session,
  -- so these checks assert the FUNCTION'S SHAPE rather than its answer —
  -- the answer is proved per-role in verify:rls, which is the only thing that
  -- can see a policy from the caller's side.
  perform public.assert(
    (select p.prosecdef from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'shares_shipment_with_org'),
    'shares_shipment_with_org is still security definer'
  );
  perform public.assert(
    (select p.proconfig @> array['search_path=public'] from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'shares_shipment_with_org'),
    '...and still pins its search_path'
  );
  perform public.assert(
    (select p.prosrc like '%trade_links%' from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'shares_shipment_with_org'),
    '...and now considers a trade link'
  );
  perform public.assert(
    not has_function_privilege('anon', 'public.shares_shipment_with_org(uuid)', 'execute'),
    '...and anon still cannot call it'
  );
  perform public.assert(
    has_function_privilege('authenticated', 'public.shares_shipment_with_org(uuid)', 'execute'),
    '...while authenticated still can'
  );

  -- THE REVOCATION CLAUSE, proved by the index rather than the predicate:
  -- a revoked link must not keep the pair uniquely occupied, or re-linking
  -- would be impossible.
  insert into public.trade_links
    (org_id, counterparty_org_id, party_role, created_by)
  values (org_a, org_d, 'consignee', owner_id)
  returning id into link;

  update public.trade_links set revoked_at = now() where id = link;

  insert into public.trade_links
    (org_id, counterparty_org_id, party_role, created_by)
  values (org_a, org_d, 'consignee', owner_id);

  perform public.assert(
    (select count(*) from public.trade_links
      where org_id = org_a and counterparty_org_id = org_d
        and revoked_at is null) = 1,
    'a revoked link frees the pair for a new one, and only one is live'
  );
end $$;


-- ---------------------------------------------------------------------------
-- A link goes with its organisation
-- ---------------------------------------------------------------------------

do $$
declare
  org_a    uuid := (select id from public.organisations where slug = 'example-freight');
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  doomed   uuid;
begin
  -- THE 0010 CLASS OF BUG, asked of this table: a guard or a reference on a
  -- cascading child that refuses the parent's own deletion. `trade_links`
  -- has no guard, but it references TWO organisations, and the second one is
  -- the one that is easy to get wrong.
  insert into public.organisations (name, slug, is_subscriber, created_by)
  values ('Doomed Senders', 'doomed-senders', false, owner_id)
  returning id into doomed;

  insert into public.memberships (org_id, user_id, role)
  values (doomed, owner_id, 'admin');

  insert into public.trade_links
    (org_id, counterparty_org_id, party_role, created_by)
  values (org_a, doomed, 'consignor', owner_id);

  -- Deleting the COUNTERPARTY must not be blocked by the transporter's link.
  delete from public.organisations where id = doomed;

  perform public.assert(
    (select count(*) from public.organisations where id = doomed) = 0,
    'deleting a counterparty organisation is not blocked by its links'
  );
  perform public.assert(
    (select count(*) from public.trade_links
      where counterparty_org_id = doomed) = 0,
    '...and the link goes with it'
  );
end $$;
