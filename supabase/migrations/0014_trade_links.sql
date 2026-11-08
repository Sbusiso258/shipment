-- 0014_trade_links.sql
--
-- THE STANDING RELATIONSHIP between a transporter and a counterparty.
--
-- `shipment_parties` (0005) grants visibility of ONE shipment. That is the
-- right grain for oversight and the wrong grain for the question this
-- migration answers: before any shipment exists, who is allowed to send this
-- transporter a request at all?
--
-- Without a standing link there is no safe answer. A request addressed by
-- matching on an email or a slug would mean any organisation could address any
-- other whose identifier it could guess — which is both spam and a probe, and
-- it would rebuild the tenant directory that 0005 and 0009 deliberately refuse
-- to be. `find_organisation_by_slug` stays the only directory-shaped thing in
-- this product, and it is not used here.
--
-- SO THE SENDER NEVER SEARCHES. The transporter creates the link, exactly as
-- it creates every other grant in this schema, and a request is only
-- insertable where a live link already says so (0015).
--
-- This table copies `shipment_parties` on purpose: both sides read, only the
-- owning admin writes, revocation is a timestamp, and a column grant stops the
-- row being moved to a different counterparty. Where a shape is already proven
-- and already swept by the verification suites, a second shape is a second
-- thing to get wrong.

create table public.trade_links (
  id uuid primary key default gen_random_uuid(),

  -- THE TRANSPORTER. The link is the transporter's own record of who may
  -- address them, so the transporter is the tenant. Not nullable, per
  -- non-negotiable 5: a nullable tenant column pushes NULL-handling into
  -- every policy forever, and the one place it is forgotten is the leak.
  org_id uuid not null references public.organisations (id) on delete cascade,

  -- The counterparty organisation — a sender, a recipient, a broker.
  counterparty_org_id uuid not null
    references public.organisations (id) on delete cascade,

  -- REUSES `party_role` RATHER THAN INVENTING A SECOND VOCABULARY. The link
  -- says "this counterparty acts as our consignor", and
  -- `accept_shipment_request` (0015) writes the SAME value into
  -- `shipment_parties` — so there is no mapping table, no translation, and no
  -- chance of the two vocabularies drifting apart. The day `broker` matters
  -- it is a row, not an `alter type`.
  party_role public.party_role not null,

  -- What the transporter files them under: an account code, a branch name.
  -- NOT a second copy of the organisation's name — see the note on
  -- `shares_shipment_with_org` below for why that was rejected.
  reference text
    check (reference is null or length(btrim(reference)) between 1 and 80),

  created_by uuid not null references auth.users (id),

  -- REVOCATION IS A TIMESTAMP, NEVER A DELETE. "They could send to us from
  -- March to August" is part of the record, and every predicate below filters
  -- on `revoked_at is null` — the load-bearing clause that makes revoking
  -- actually do something.
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint trade_links_not_self check (counterparty_org_id <> org_id),

  -- Same one-directional shape as `tasks_completer_implies_completion`
  -- (0007): "revoked, by somebody unknown" is real, because `auth.uid()` is
  -- null outside a user session. "Revoked by somebody at no time" is not.
  constraint trade_links_revoker_implies_revocation
    check (revoked_by is null or revoked_at is not null),

  -- THE KEYSTONE, the same shape as `shipments unique (id, org_id)`: it lets
  -- `counterparty_invitations` (0017) prove through one composite foreign key
  -- that the link it creates belongs to the transporter that issued the
  -- invitation, instead of joining through this table's policy.
  unique (id, org_id)
);

-- One live link per counterparty per role. Re-linking somebody who was
-- revoked is a new row, so the history reads as a sequence of spells.
create unique index trade_links_active_idx
  on public.trade_links (org_id, counterparty_org_id, party_role)
  where revoked_at is null;

-- THE INDEX THE REQUEST INSERT CHECK IN 0015 DEPENDS ON. That policy's
-- `exists` clause looks up (transporter, sender); without this index every
-- request insert scans every link in the database.
create index trade_links_counterparty_idx
  on public.trade_links (counterparty_org_id, org_id)
  where revoked_at is null;

create trigger trade_links_set_updated_at
  before update on public.trade_links
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- trade_links RLS
-- ===========================================================================

alter table public.trade_links enable row level security;

-- BOTH SIDES READ, exactly as `shipment_parties_select_viewer` does: the
-- transporter manages the link, and the counterparty has a right to know who
-- it has been connected to and in what role.
--
-- NO PLATFORM-ADMIN BRANCH, deliberately. A commercial relationship between
-- two customers is their business, and the same judgement is already made for
-- `messages` (0007) and `decision_logs` (0012) — the platform owner is
-- structurally locked out of both.
create policy trade_links_select on public.trade_links
  for select to authenticated using (
    public.is_org_member(org_id)
    or public.is_org_member(counterparty_org_id)
  );

-- Only the TRANSPORTER's admins may link or unlink. A counterparty cannot
-- connect itself to a carrier, and cannot pass its connection on.
create policy trade_links_insert_owner_admin on public.trade_links
  for insert to authenticated with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
    and created_by = (select auth.uid())
  );

create policy trade_links_update_owner_admin on public.trade_links
  for update to authenticated using (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  )
  with check (
    public.has_org_role(org_id, array['admin']::public.membership_role[])
  );

-- No DELETE policy: revoked with `revoked_at`, never removed.

-- COLUMN PRIVILEGES ARE THE REAL RULE HERE, and `with check` structurally
-- cannot express it. The check above only inspects `org_id`, which stays true
-- after an admin rewrites `counterparty_org_id` — so without this revoke, an
-- admin could point an existing link at a different organisation and inherit
-- whatever that link already permits. The same mechanism guards
-- `organisations` (0001), `messages` (0007) and `shipment_assignments` (0008).
revoke update on public.trade_links from authenticated;
grant update (revoked_at, revoked_by, reference)
  on public.trade_links to authenticated;


-- ===========================================================================
-- Widening the counterparty name lookup
-- ===========================================================================
--
-- THIS IS THE SECURITY-CRITICAL PART OF THIS MIGRATION. It changes an
-- RLS-bypassing `security definer` function, so by this project's own rule
-- (AGENTS.md, "that function is security-critical code") `verify:rls` is
-- mandatory on this change and not merely advisable.
--
-- Why it is needed: `organisations_select_counterparty` (0005) admits another
-- organisation only via `shares_shipment_with_org`, which is true only once a
-- shipment grant exists. A newly linked sender would therefore be unable to
-- read even the NAME of the transporter that linked them — their first screen
-- would render uuids, and the cause would be invisible.
--
-- Rejected alternative: denormalising `counterparty_name` onto `trade_links`.
-- A display name stored beside an id is a second version of one fact, and the
-- day they disagree the wrong one is already in the permanent record — the
-- same argument `resolveFleetText` in src/services/shipments.ts makes for
-- reading a driver's name off the fleet row instead of accepting it from a
-- form.
--
-- The widening is symmetric and minimal: a live link, in either direction,
-- yields the other organisation's name and nothing else. No shipment, no
-- checkpoint, no depot, no member.

create or replace function public.shares_shipment_with_org(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.shipment_parties p
    where p.revoked_at is null
      and p.org_id = target_org
      and p.party_org_id = any (public.my_org_ids())
  )
  or exists (
    select 1
    from public.shipment_parties p
    where p.revoked_at is null
      and p.party_org_id = target_org
      and p.org_id = any (public.my_org_ids())
  )
  -- NEW IN 0014: a live trade link, either direction.
  or exists (
    select 1
    from public.trade_links tl
    where tl.revoked_at is null
      and (
        (tl.org_id = target_org
          and tl.counterparty_org_id = any (public.my_org_ids()))
        or (tl.counterparty_org_id = target_org
          and tl.org_id = any (public.my_org_ids()))
      )
  );
$fn$;

-- Unchanged from 0005, restated because `create or replace` does not reset
-- privileges and leaving it implicit would make the grant invisible here.
revoke execute on function public.shares_shipment_with_org(uuid) from public, anon;
grant execute on function public.shares_shipment_with_org(uuid) to authenticated;

comment on table public.trade_links is
  'Standing relationship between a transporter and a counterparty, created by '
  'the transporter. A live link is what makes a shipment request insertable; '
  'it grants no sight of any shipment on its own.';
