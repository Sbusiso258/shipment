# Shelved work

Files here are written and kept, but deliberately **not** part of the migration
sequence or the verification suites. Nothing in `supabase/migrations/` or
`src/` depends on them.

## `0014_trade_links.sql` and `verify-behaviour-9-trade-links.sql`

The first migration of a three-party expansion: a standing `trade_links`
relationship between a transporter and a counterparty, so that a sender could
raise a shipment request before any shipment exists. It also widens
`shares_shipment_with_org` with a third branch, which is a change to an
RLS-bypassing `security definer` function and therefore a security change.

**Why it is here and not applied:**

- It is **new product surface**, and the directive it was written for was
  superseded by one that is explicitly about completing *existing*
  functionality rather than adding to it.
- It was **never verified**. `npm run verify:migrations` has not passed with it
  in place, and the behaviour file references fixture organisations
  (`bravo-logistics`, `delta-distribution`) that may not exist in
  `supabase/verify-behaviour.sql`. Assume it is broken until proven otherwise.
- Leaving it in `supabase/migrations/` made the live project look two
  migrations behind when it is one, which muddied the real question of what
  production actually has.

**If the three-party work resumes:** the design behind these files — including
why a counterparty gets its own tables rather than write access to `shipments`,
and why the sender never searches for a transporter — was recorded in the plan
that produced them. Renumber to whatever is next free at the time; `0014` will
almost certainly be taken.

**Do not paste either file into a SQL editor.** Neither has been through
`verify:migrations`, `verify:rls` or `verify:upgrade`.
