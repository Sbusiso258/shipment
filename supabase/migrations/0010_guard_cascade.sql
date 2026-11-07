-- 0010_guard_cascade.sql — an organisation can be deleted again.
--
-- THE BUG, AND IT HAS BEEN THERE SINCE 0001: `delete from organisations`
-- fails for every organisation that has an admin. Which is every organisation,
-- because `memberships_guard_last_admin` refuses to let the last one go.
--
-- `memberships.org_id` carries `on delete cascade`, so deleting an
-- organisation deletes its memberships — and that cascade fires this BEFORE
-- DELETE trigger once per member. The guard then asks "would this organisation
-- be left with no admin?", finds the answer is yes, and raises:
--
--     Organisation <id> would be left with no admin   (check_violation)
--
-- The question is meaningless in that context. There is no organisation left
-- to leave without an admin; it is being deleted in the same statement.
--
-- WHAT THIS COST. `organisations_delete_platform` has existed since 0001 and
-- has never once been usable. The demo seed's own header told the owner to
-- clean up with `delete from public.organisations where slug =
-- 'demo-logistics'`, which would have failed with a constraint name and no
-- explanation. The "Remove demo data" control on /admin/setup would have
-- failed the same way — found by a PGlite rehearsal of that screen rather
-- than by the owner clicking it against their live project.
--
-- THE FIX is to let the guard notice that the parent is already gone.
-- Postgres runs `ON DELETE CASCADE` as an AFTER-ROW trigger on the parent, so
-- by the time this BEFORE-DELETE trigger runs on the child, the
-- `organisations` row is no longer visible in this transaction. Asking for it
-- is therefore an exact test of "is the organisation itself going?" — not a
-- heuristic.
--
-- The guard is `security definer`, so it sees the true state rather than
-- whatever the caller's policies admit. That matters here: an org admin
-- deleting their own organisation must get the same answer as the platform
-- owner.
--
-- WHAT IS DELIBERATELY NOT CHANGED: removing the last admin while the
-- organisation STAYS is still refused, and `verify-behaviour.sql` still
-- asserts it. That rule is what stops an organisation locking itself out, and
-- it is the reason this trigger exists at all.
--
-- Forward-only. Never edit a migration that has been applied.


create or replace function public.memberships_guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  remaining integer;
begin
  -- The organisation itself may be going. See the header: this trigger fires
  -- once per member during a cascade, and "left with no admin" has no meaning
  -- when there is nothing left.
  if tg_op = 'DELETE'
     and not exists (
       select 1 from public.organisations o where o.id = old.org_id
     )
  then
    return old;
  end if;

  -- Only the removal or demotion of an admin can empty the set.
  if tg_op = 'UPDATE' and old.role = 'admin' and new.role = 'admin' then
    return new;
  end if;
  if old.role <> 'admin' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  select count(*) into remaining
  from public.memberships
  where org_id = old.org_id
    and role = 'admin'
    and id <> old.id;

  if remaining = 0 then
    raise exception
      'Organisation % would be left with no admin', old.org_id
      using errcode = 'check_violation';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$fn$;
