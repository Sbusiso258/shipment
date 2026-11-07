-- 0009_counterparty_lookup.sql — finding the customer you are about to share with.
--
-- THE PROBLEM THIS SOLVES, stated plainly: an admin cannot grant a
-- counterparty visibility of a shipment, because they cannot see that the
-- counterparty exists.
--
-- `organisations_select_counterparty` (0005) admits an organisation only when
-- the caller already SHARES a shipment with it. That is right — a tenant list
-- readable by every tenant would hand every carrier their competitors' client
-- book — but it is circular for the FIRST grant: you need the organisation's
-- id to create the grant, and the grant is what would let you read the id.
--
-- So the product today can only make a second grant to a customer who somehow
-- already has one. There is no screen that can create the first.
--
-- THE TRADE-OFF, WRITTEN DOWN RATHER THAN BURIED. This function lets an admin
-- learn that an organisation with a given slug exists. Slugs are chosen by
-- people and therefore low-entropy, so that is a real — if small —
-- enumeration oracle. It is bounded four ways:
--
--   exact match only, so it cannot be used to browse
--   one row maximum, so it cannot be used to count
--   three columns, so a hit reveals a name the customer already gave out
--   admins only, so an operator or a viewer cannot call it at all
--
-- The alternative was the platform owner wiring up every grant by hand, which
-- puts a person in the path of the product's core workflow. That is worse.
--
-- What this is NOT: a search. No prefix matching, no similarity, no listing.
-- Those would each turn a lookup into the directory this deliberately avoids.
--
-- Forward-only. Never edit a migration that has been applied.


create or replace function public.find_organisation_by_slug(target_slug text)
returns table (id uuid, name text, slug text)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  -- The authorisation check is the FIRST statement in the body, before any
  -- data is touched — the same shape as `org_members` in 0006. A definer
  -- function without one is an open door.
  --
  -- "An admin of some organisation", not "an admin of a particular one":
  -- the caller is looking for a counterparty precisely because no shipment
  -- links them yet, so there is no organisation to name here.
  if not exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid())
      and m.role = 'admin'
  ) then
    raise exception 'Only an organisation admin can look up a counterparty'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select o.id, o.name, o.slug
  from public.organisations o
  where o.slug = lower(btrim(target_slug))
    and o.status = 'active'
  limit 1;
end;
$fn$;

-- `revoke from public` does NOT take execute away from `anon` — Supabase's
-- default privileges grant it explicitly. This was a real bug in 0001 and the
-- revoke must name the role.
revoke execute on function public.find_organisation_by_slug(text) from public, anon;
grant execute on function public.find_organisation_by_slug(text) to authenticated;

comment on function public.find_organisation_by_slug(text) is
  'Resolves an exact organisation slug to an id, for an admin about to grant '
  'a counterparty visibility of a shipment. Exact match only, one row, three '
  'columns, admins only. Deliberately not a search.';
