<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Shipment Oversight

A multi-tenant oversight layer sold to logistics businesses. We do not run
logistics. We show a shipment's journey — origin to destination, every
checkpoint in between — so nobody has to phone anyone to ask where the load is.

Confirmed Next 16 differences already relied on here: the middleware file
convention is **`proxy.ts`** exporting a function named `proxy`, and `cookies()`
is **async**.

## Layering — enforced, not aspirational

Dependencies run one way: `app → components → hooks → services → lib → types`.

- **`src/lib/**` is pure.** No Supabase, no `fetch`, no ambient clock — pass the
  reference date in. The journey rules live here so they can be unit-tested over
  fixed fixtures. **If "is this shipment late" is decided inside a component,
  the architecture has failed.**
- **`src/services/**` is the only code that talks to Supabase.** It maps rows to
  the domain types in `src/types/domain.ts`; raw snake_case rows never escape it.
- **`src/components/**` renders props.** No queries, no lateness maths.

## Non-negotiables

1. **No service-role key, anywhere.** Anon key plus RLS only. Authorization is a
   database property, never a UI one. A hidden button is not a permission.
2. **Every table gets RLS in the same migration that creates it.** Use
   `(select auth.uid())`, not a bare `auth.uid()` — the subquery is evaluated
   once per statement, not once per row.
3. **Every policy is scoped `to authenticated`.** Never leave the role list off
   — an unscoped policy applies to `PUBLIC`, which includes `anon`.

   Two reasons, both found by `verify:rls` rather than by reading the SQL.
   A policy expression is evaluated **as the querying role**, so an unscoped
   policy calling `is_org_member()` requires `anon` to hold `execute` on a
   function that bypasses RLS. And with no policy applicable to `anon`, an
   anonymous request matches nothing structurally, instead of relying on
   `auth.uid()` being null inside an expression somebody got right.

   Relatedly: **`revoke execute ... from public` does not take execute away
   from `anon`.** Supabase's default privileges grant it to `anon` explicitly,
   so the revoke must name `anon`. This was a real bug in `0001`.
4. **Every UPDATE policy repeats its `using` clause as `with check`.** `using`
   decides which rows may be *targeted*; `with check` decides what a row may
   *become*. With only `using`, an org admin can
   `update shipments set org_id = '<other org>'` — the row passes a check that
   does not exist and the shipment silently migrates to another tenant. This is
   the quietest multi-tenant leak in Postgres, and **no read-only test catches
   it.** `verify:rls` asserts it explicitly.
5. **Tenancy is `org_id`, and it is never nullable on an ownable entity.** A
   nullable tenant column pushes NULL-handling into every query and every policy
   forever, and the one place it is forgotten is the leak.

   **`org_id` on `checkpoints` is load-bearing, not redundant.** It looks
   duplicative next to `shipment_id`, and a composite foreign key
   `(shipment_id, org_id) references shipments (id, org_id)` already proves the
   two agree. Remove it and every checkpoint read becomes a join through the
   `shipments` policy — a two-hop RLS evaluation per row. Do not normalise it
   away.
6. **Party organisations read; they never write.** That asymmetry is the
   product. Any policy that grants a party `insert`, `update` or `delete` on a
   shipment it does not own is a bug, not a feature request.

   The one exception, added in `0007`: a live, **messaging-enabled** grant lets
   a party insert into `messages`. Correspondence about a journey is not a
   claim about the journey — a consignee can ask where the load is; they still
   cannot say it was delivered.

7. **An admin sees their whole organisation. Everyone else sees only what is
   assigned to them.** Enforced by `can_view_shipment()` as rewritten in
   `0008`, and `shipment_assignments` is the grant.

   **A narrowed predicate behind an `or is_org_member(org_id)` is inert.** That
   branch was on every shipment-data policy, and removing it from all of them
   is what makes the narrowing real. Any new policy that re-admits every member
   to shipment data undoes `0008` for that table, silently and in the leaking
   direction — `verify-behaviour-4-assignment.sql` sweeps for it.

   **Reads and writes narrow together.** A SELECT restriction with the write
   policies left alone gives an operator an *invisible* edit, which is worse
   than a visible read.

   **`locations` and `sa_places` are deliberately NOT narrowed.** An operator
   who cannot name their own depots cannot log a pickup. Tightening them would
   break the core loop while looking like security.
8. **Migrations are forward-only and numbered.** Never edit an applied one.

   **A trigger on a child table fires during a parent's cascade, and it does
   not know that.** `memberships_guard_last_admin` asked "would this
   organisation be left with no admin?" while the organisation itself was
   being deleted, so `delete from organisations` failed for every tenant that
   had one — which is all of them. `organisations_delete_platform` was
   therefore unusable from 0001 until 0010 taught the guard to check whether
   the parent still exists. Any future guard on a cascading child needs the
   same question asked of it.

9. **A guard that asks "who is asking" must put its data rules ABOVE that
   question.** `shipments_guard_transition` returns early when `auth.uid()`
   is null, because its reopen and reinstate rules call `has_org_role` and
   there is no role to check outside a session. The delivery-before-dispatch
   rule was written below that early return, so it was dead for every caller
   without a session — and the suite that would have proved it runs without
   one. A fact about the ROW goes first; only the questions about the CALLER
   go after. (The 0004 constraint does not cover this: it
   short-circuits on `dispatched_at is null`, so a delivery with no dispatch
   at all passes it.)

10. **Money is `numeric(14,2)`.** Never float. `cargo_value` is **nullable and
   null means "not disclosed"** — never `0`. An undisclosed cargo value has not
   been measured; writing `0` claims the load is worthless.
11. **`timestamptz` for instants, `date` for a day promised to a human.** The
   server runs UTC and South African operators do not.

   `promised_delivery_date` is the **only** `date` column, and that asymmetry is
   deliberate: a commercial commitment is made in days ("delivered by
   Thursday"), while an ETA is an instant. **A shipment promised *today* is not
   late at 15:00 — the day is not over.** Judge lateness against the end of the
   promised day in the organisation's IANA zone, via `src/lib/date.ts`. Compare
   a promise-day to an instant without that and "late" acquires a two-hour
   error: the server rolls the day over at 02:00 local, and the board screams at
   ops every afternoon until they stop reading it. **A false alarm costs more
   than a missed one**, because the only thing this product sells is being
   believed.
12. **A checkpoint needs at least one of `planned_at` / `actual_at`.** Enforced
   by a check constraint. A checkpoint with neither is not an event.
13. **The database counts; the library judges.** Trigger-maintained aggregates
    (`last_event_at`, checkpoint counts) live in Postgres, because the board
    must sort hundreds of shipments without shipping every checkpoint over the
    wire. Every *judgement* — late, at risk, silent, current position — lives in
    `src/lib/journey.ts` as a pure function taking `now` and the timezone as
    arguments. Views may coalesce; they may never judge.

## RLS: the recursion trap, and why `caller_org_ids()` exists

A policy on `shipments` must ask "is the caller a member of the owning org?",
which reads `memberships`. A policy on `memberships` that also reads
`memberships` recurses, and Postgres raises
`infinite recursion detected in policy`.

The mitigation is `public.caller_org_ids()`, a `security definer` function that
reads memberships with RLS bypassed.

**That function is security-critical code.** It stays one line, it filters on
`(select auth.uid())` internally so it can only ever return the caller's own
rows, it pins `set search_path = ''` so a planted schema cannot shadow
`memberships`, and `execute` is revoked from `public` and granted only to
`authenticated`. Changing it is a security change. Re-run `verify:rls`.

## Verifying

```bash
npm run typecheck && npm run lint && npm run test && npm run verify:migrations
npm run verify:rls
```

**Never hand a migration to a SQL editor unverified.** `verify:migrations`
rebuilds the whole schema on a throwaway Postgres and asserts what the DDL
claims. It runs on **PGlite** — real Postgres compiled to WebAssembly, in this
process — so it needs no server, no port and no password. That is deliberate: a
verification step that requires local setup is one that silently stops being
run, and a check nobody runs is worse than no check at all.

**Every constraint and trigger a migration introduces gains a check in
`supabase/verify-behaviour.sql`.** A constraint nobody has watched reject
something is a comment with semicolons in it. Assertions record into
`verification.log` rather than `raise notice`, and the runner prints the count,
so a file that stops executing halfway is visible instead of looking green.

Two structural sweeps in that file are worth more than any individual check,
because they cover tables that do not exist yet: every table in `public` has RLS
enabled, and every `UPDATE` policy carries both `using` and `with check`.

It **cannot prove RLS**: the role running it owns the tables, and an owner
bypasses its own row-level security. That is a fact about the *role*, not the
database — so `verify:rls` stops being the owner. It applies the same
migrations, then `set role authenticated` with a jwt claim, which makes every
policy live. `verify-stubs.sql` reproduces Supabase's default privileges so
`authenticated` holds the grants it holds in production; without that, queries
would fail on privileges before reaching a policy and the suite would be green
for the wrong reason.

**A missing table fails loudly on first load. A missing policy fails silently,
and only in the direction that leaks.** `verify:rls` is the only thing in this
repository that can see the second case. Every new table gets scenarios there
in the same change that creates it.

This is a faithful reproduction of Supabase's authorisation model, not Supabase
itself. Run it on every change because it is free; **also run the same
scenarios against the real project with real users before the first paying
customer.**

## The counterparty lookup, and why it is the one directory-shaped thing here

`find_organisation_by_slug` (0009) resolves an exact organisation slug to an
id. It exists because granting a NEW customer visibility was otherwise
impossible: `organisations_select_counterparty` admits an organisation only
once you already share a shipment with it, so you needed the id to make the
grant and the grant to read the id.

**It is a lookup, never a search.** Exact match, one row, three columns,
admins only. Adding prefix matching, similarity or a listing would turn it
into the tenant directory the policy in 0005 deliberately refuses to be — and
a carrier browsing their competitors' client book is the worst thing this
schema could leak.

The cost, stated rather than buried: an admin can learn that an organisation
with a given slug exists. Slugs are human-chosen and therefore low-entropy, so
that is a small enumeration oracle. It was taken knowingly, against the
alternative of the platform owner wiring up every grant by hand.

## Reading a column before its migration is applied

**Adding a column to a service's `COLUMNS` string takes down every page that
reads that table — not just the new feature.** Adding `driver_id, vehicle_id`
to the shipments select made the whole application 500 against a project still
on 0007, the dashboard included, because the shell reads shipments on every
route. The fleet pages had been failing on their own for a while and that was
tolerable; this was not, and the gate cannot see it: `typecheck`, `lint`,
`test`, `verify:migrations`, `verify:rls` and a clean 20-route build all passed
while the live app was dead.

So: **apply the migration BEFORE merging the code that reads it**, and when
the two cannot be simultaneous, expect the app to be down in between and say
so rather than discovering it.

`isSchemaBehind` in `src/services/fail.ts` now classifies Postgres `42703`
(undefined_column) and `42P01` (undefined_table) alongside PostgREST's
`PGRST205`. Before that it caught a missing TABLE and not a missing COLUMN, so
this failure printed the bare error instead of the paragraph telling somebody
which command to run — and a missing column is the commoner case, because a
column gets read by code shipped ahead of its migration far more often than a
table does. The message-shape fallback is deliberately narrow: `does not exist`
alone also describes a missing row, a missing role and a missing function, none
of which is a migration problem.

`src/app/(app)/shipments/[id]/page.tsx` shows the pattern for a SIDE panel —
`orNoticed` catches `SchemaBehindError`, the panel renders a notice naming the
migration, and the page still shows the shipment somebody came to look at. A
panel degrades. A table the whole shell reads does not.

## Running the gate while a dev server is up

`next build` and `next dev` both write to `.next`, and building while a dev
server runs leaves that server unable to find its own Turbopack runtime. Every
route then 500s with no application stack trace, which reads exactly like a
code bug and is not one.

```bash
NEXT_DIST_DIR=.next-build npm run build && rm -rf .next-build
```

`distDir` is wired to that variable in `next.config.ts`. Use it rather than
stopping somebody else's server, and delete the directory afterwards.

## Applying a migration to a project that is already live

```bash
bash supabase/bundle-migration.sh 0008 0009 0010   # -> apply-0008-0010.sql
npm run verify:upgrade 0008 0009 0010
```

Several at once when a project is behind: two pastes are two chances to paste
the wrong thing, to miss an error that scrolled past, or to stop after the
first. One transaction catches the database all the way up, and there is one
result to read instead of two.

`supabase/diagnose.sql` reads the catalogue directly and says which migration
a live project has actually reached — a 404 from the REST API cannot tell a
missing migration from a stale PostgREST cache.

**When the SQL editor is not working, stop pasting.**

```bash
npm run db:check                                     # read-only
npm run db:run supabase/apply-0008-0010.sql --confirm
```

`supabase/remote.mjs` connects to Postgres directly and prints the real error,
with its code, its position and the offending line. It exists because five
consecutive pastes into the editor failed with no diagnosis available: a run
that does nothing prints the same "Success. No rows returned" as a run that
worked.

It reads `SUPABASE_DB_URL` from `.env.local`, refuses anything that changes
the database without `--confirm`, and redacts the connection string from every
line it prints — that string IS the database password. Nothing in `src/`
imports it, and it is not a way around RLS; it is a psql substitute on a
machine with no psql.

`apply-all.sql` is for a FRESH project and must never be re-run against a live
one. A live project takes one new numbered migration at a time, wrapped in a
transaction by `bundle-migration.sh`.

**`verify:upgrade` asks a different question from `verify:migrations`.** That
one builds the schema from nothing, which proves the DDL is valid. This one
applies every earlier migration, puts rows in, and then runs the bundle BYTE
FOR BYTE as it will be pasted — because "valid DDL" and "applies to the
database that exists" are not the same claim, and the second one is tested at
the worst possible moment: in a SQL editor, pointed at production.

It also pastes it twice. Somebody will: the editor is slow, the tab gets
reloaded, it is not obvious the first one worked. What it asserts is that the
SCHEMA IS UNCHANGED afterwards, not that the second attempt errored — a
migration made only of `create or replace function` applies again and changes
nothing, and demanding an error would fail it for being idempotent.

What it cannot know is what is actually in the live project. Take a backup.

Verify the app with `npm run build && npm run start`, **not** `npm run dev` —
Turbopack Fast Refresh double-mounts and hides effect bugs.

## The map

**MapLibre GL JS + OpenFreeMap vector tiles.** Free, no API key, no billing
account, and — unlike the obvious alternative — no restriction on commercial
use.

**Why not Leaflet + `tile.openstreetmap.org`.** It was the first choice and it
is the wrong one for a product that is sold. The OSM Foundation's Tile Usage
Policy does not permit commercial-scale consumption of their tile servers; the
remedy for exceeding it is being blocked. Most free raster alternatives
(Thunderforest, Stadia) likewise restrict their free tier to non-commercial
projects. OpenFreeMap serves OSM-derived vector tiles with no key, no quota and
no commercial restriction, and the whole stack is self-hostable if that ever
changes. Mapbox and Google are both out on the stated constraint — they require
a billing account, Google from the first request — and Google is doubly out
because its terms forbid *storing* coordinates, which this schema does.

- **Use `maplibre-gl` directly. Do not add `react-map-gl`.** It pins to specific
  MapLibre versions, has been slow to accept React 19, and adds a reconciliation
  layer that buys nothing for one static map. One component, one ref, one
  effect.
- **Confined to `src/components/journey/journey-map-gl.tsx`**, loaded through
  `next/dynamic` with `ssr: false` from a `"use client"` wrapper. MapLibre
  touches `window` at import time. Note that **`dynamic(..., { ssr: false })` is
  not allowed in a Server Component** — the wrapper must itself be a client
  file. This is the most common way a map breaks an App Router build.
- **`maplibre-gl/dist/maplibre-gl.css` must be imported** in that client
  component or the controls render as unstyled blocks.
- **`flyTo` before the style has loaded is silently dropped.** Store a promise
  resolved by `map.once("load")` in a ref and await it before any camera call.
  Otherwise the first click after a cold load does nothing, roughly one time in
  three depending on network speed — the kind of bug that gets dismissed as
  imagination.
- **The container needs an explicit height.** A computed height of 0 renders a
  0×0 map that never recovers; call `map.resize()` from a `ResizeObserver` when
  the grid collapses at the `lg` breakpoint.
- **`fitBounds` runs once per point-set, never on selection change.** Refitting
  on selection makes the map lurch every time someone reads a row.
- **Attribution is a licence condition, not decoration.** Never hide it or
  restyle it to nothing.
- **`NEXT_PUBLIC_MAP_STYLE_URL` is the upgrade seam.** MapLibre consumes a style
  URL and nothing in the component knows where tiles come from, so moving to
  MapTiler, Protomaps or a self-hosted tileserver is one environment variable.
- **`route-schematic.tsx` is a real fallback, not a stub.** It plots the same
  coordinates on a plain projection of the South African bounding box with the
  same markers and the same selection behaviour, and renders whenever the style
  URL is unset or the GL context fails. Keep it working: it is also the
  print-safe rendering, and customers will print the journey view.
- **No geocoding.** Coordinates come from the seeded gazetteer, from an operator
  pasting a real pin, or from clicking the map. Free-text locations are not
  allowed: a route with gaps is worse than a route with fewer stops. If forward
  geocoding is ever added it is Nominatim or Photon, server-side, behind an
  explicit button — **never type-ahead.** Nominatim's policy caps one request
  per second and forbids autocomplete use; wiring it to an input's `onChange`
  violates that and gets the IP blocked.

## Data honesty

This product records *claims about a journey* and derives every judgement from
them. It never invents a fact it was not told. Three specific prohibitions, each
of which is a tempting feature:

- **Never interpolate a position.** A truck is drawn at its **last confirmed
  checkpoint**, never at a plausible midpoint between two stages. An
  interpolated dot is a fabricated GPS fix and it is the most damaging thing
  this product could ship: the day a customer realises the dot was a guess,
  every other number on the page becomes a guess too. There is deliberately no
  `midpoint()` in `src/lib/geo.ts`.
- **Never guess an ETA.** A stage with no `planned_at` renders "no planned
  time", not an estimate derived from the other stages.
- **Never invent a coordinate.** See the location rule below.

- **No fabricated data presented as real.** Placeholders are labelled as
  placeholders. Never lorem ipsum, never invented customers, never a screenshot
  of made-up shipments passed off as the product working.
- **Location coordinates come from an attributed open dataset**, recorded in
  `docs/data-sources.md`. Never hand-typed from memory — a plausible-looking
  wrong pin is worse than no pin, because nobody checks a pin that looks right.

## Known limits, written down rather than discovered later

- **The oversight board computes trouble client-side**, so it fetches every open
  shipment. Fine at V1 volumes. The seam for scale is a `shipments_with_state`
  view or a trigger-maintained `last_checkpoint_at` column.
- **PostgREST types come from a *literal* select string.** A `COLUMNS` constant
  built by concatenation widens to `string`, inference collapses to
  `GenericStringError`, and results must be cast through `unknown`. The
  hand-written `*Row` interface in each service is therefore the real contract
  with the database — keep it in step with `COLUMNS` and the migrations.
- **Checkpoint kinds will grow** (cross-border adds `customs_hold`,
  `customs_cleared`, `border_post`). The journey is an ordered list of event
  rows precisely so that growth is `alter type ... add value` rather than a
  schema rebuild. Do not "simplify" it into a fixed column per stage.
