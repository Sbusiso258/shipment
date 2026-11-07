-- 0006_provisioning.sql — the two things the admin screens cannot do with RLS
-- alone.
--
-- Both are `security definer`, so both are security-critical code and obey the
-- same five rules as the predicates in 0001: definer, pinned search_path,
-- stable or volatile as appropriate, NO user-id parameter, and execute revoked
-- from public and anon.
--
-- Forward-only. Never edit a migration that has been applied.


-- ===========================================================================
-- org_members — who else is in my organisation
-- ===========================================================================
-- An org admin needs their colleagues' names and email addresses to manage a
-- team. Those live in `auth.users` and `profiles`, and RLS cannot reach them:
-- `profiles` is own-row-only, deliberately.
--
-- THE LAZY FIX WOULD HAVE BEEN TO WIDEN THAT POLICY to "anyone who shares an
-- organisation with me". That would expose every profile column to every
-- colleague, forever, for the sake of two fields on one screen. This function
-- returns exactly the five values the screen renders and nothing else.

create or replace function public.org_members(target_org uuid)
returns table (
  user_id    uuid,
  full_name  text,
  email      text,
  role       public.membership_role,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  -- The authorisation check is the first statement in the body, before any
  -- data is touched. A definer function without one is an open door.
  if not (
    public.has_org_role(target_org, array['admin']::public.membership_role[])
    or public.is_platform_admin()
  ) then
    raise exception 'Not permitted to list members of this organisation'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    m.user_id,
    p.full_name,
    u.email::text,
    m.role,
    m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.org_id = target_org
  order by m.created_at;
end;
$fn$;


-- ===========================================================================
-- claim_invitations — for somebody invited AFTER they already had an account
-- ===========================================================================
-- `handle_new_user` converts pending invitations into memberships when a user
-- first appears. It cannot help a user who already exists and is later invited
-- to a second organisation: the trigger has already fired, once, forever.
--
-- Without this, that user sits on /no-access with a pending invitation that
-- nothing will ever action — a dead end with no error message, which is the
-- worst kind.
--
-- It matches on the email `auth.users` holds for the CALLER, never on anything
-- supplied by them, so it can only ever claim invitations addressed to the
-- account they are signed in as.

create or replace function public.claim_invitations()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  caller_email text;
  claimed      integer;
begin
  select lower(btrim(u.email)) into caller_email
  from auth.users u
  where u.id = (select auth.uid());

  if caller_email is null then
    return 0;
  end if;

  with pending as (
    select i.id, i.org_id, i.role, i.invited_by
    from public.invitations i
    where i.email = caller_email
      and i.accepted_at is null
      and i.revoked_at is null
      and (i.expires_at is null or i.expires_at > now())
  ),
  inserted as (
    insert into public.memberships (org_id, user_id, role, invited_by)
    select p.org_id, (select auth.uid()), p.role, p.invited_by
    from pending p
    on conflict (org_id, user_id) do nothing
    returning 1
  )
  update public.invitations i
  set accepted_at = now(),
      accepted_by = (select auth.uid())
  from pending p
  where i.id = p.id;

  get diagnostics claimed = row_count;
  return claimed;
end;
$fn$;


revoke execute on function public.org_members(uuid) from public, anon;
revoke execute on function public.claim_invitations() from public, anon;

grant execute on function public.org_members(uuid) to authenticated;
grant execute on function public.claim_invitations() to authenticated;
