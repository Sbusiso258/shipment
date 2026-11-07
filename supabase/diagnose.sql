-- diagnose.sql — what does the live database actually have?
--
-- Paste into the Supabase SQL editor and run it. It changes nothing.
--
-- WHY THIS AND NOT THE REST API. PostgREST answers from a SCHEMA CACHE, so a
-- 404 from the API is two different problems wearing the same face: the
-- migration never ran, or it ran and the cache has not caught up. These
-- queries read the catalogue directly, so they see what is really there.

select
  current_database()                                      as database,
  to_regclass('public.shipments')                         as at_0004,
  to_regclass('public.shipment_parties')                  as at_0005,
  to_regclass('public.tasks')                             as at_0007,
  to_regclass('public.shipment_assignments')              as at_0008,
  to_regproc('public.find_organisation_by_slug')          as at_0009,
  -- 0010 is a function REPLACEMENT, so there is nothing new to look for.
  -- This is the behaviour it restores: can an organisation be deleted at all?
  (select count(*) from pg_trigger t
    where t.tgname = 'memberships_guard_last_admin')      as guard_present;

-- The three things 0008 has to be true for, beyond the table existing.
select
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'shipments' and cmd = 'SELECT')
                                                          as shipment_select_policies,
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('shipments', 'checkpoints')
      and cmd = 'SELECT'
      and qual like '%is_org_member%')                    as must_be_zero,
  (select count(*) from public.shipments)                 as your_shipments,
  (select count(*) from public.organisations)             as organisations;

-- HOW TO READ IT
--
--   at_0008 and at_0009 both NULL
--     Nothing applied. It is all inside one transaction, so nothing is
--     half-done — re-run supabase/apply-0008-0010.sql and read the editor's
--     error this time. Scroll the RESULTS pane, not the script pane.
--
--   both NON-NULL, and the app still 500s
--     It applied; PostgREST is holding a stale cache:
--         notify pgrst, 'reload schema';
--     or restart the project under Settings → General.
--
--   must_be_zero is NOT 0
--     A policy still admits every member of an organisation to shipment data,
--     so the 0008 narrowing is inert. Say so rather than working around it.
