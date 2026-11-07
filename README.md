# Shipment Oversight

A multi-tenant shipment visibility platform. Logistics businesses record their
shipments and the checkpoints along each journey; the parties to a shipment get
read-only visibility. Nobody has to phone anyone to ask where the load is.

**This is an oversight product, not a logistics business.** It shows what has
been done on a shipment. It does not move freight, and it does not invent
anything it was not told — see the data honesty rules in [AGENTS.md](AGENTS.md).

---

## Status

**V1 is feature-complete. The schema has not been applied to a live project yet.** The toolchain is up, the project builds, an unconfigured
install correctly shows a setup notice rather than a stack trace, and the
whole schema — identity, tenancy, locations, shipments, checkpoints and
cross-organisation visibility — is verified against a throwaway Postgres. The
board lives at `/`, a shipment's journey at `/shipments/<id>`, and both read
from Supabase through `src/services`. **Nothing has been run against a real
Supabase project yet** — see below. There is no
database connected and no shipment data.

| Phase | | |
|---|---|---|
| 1 | Scaffold and configs | **done** — typecheck, lint and build pass |
| 2 | Supabase wiring and auth gate | **done** — verified in the browser |
| 3 | Core migration — organisations, memberships, RLS | **done** |
| 4 | Locations migration and gazetteer seed | **done** — 521 real places |
| 5 | Shipments, checkpoints and parties | **done** |
| 6 | Journey view with route map | **done** |
| 7 | Shipment list and oversight board | **done** — 63 unit tests |
| 8 | Wire the screens to real data | **done, unverified against a live project** |
| 9 | Checkpoint logging | **done** |
| — | Owner provisioning screens | **done** |

`supabase/migrations/0001_identity.sql` has **not** been applied to your real
Supabase project yet — only to the throwaway verification database. It is
verified, not deployed.

Writing `verify:rls` found two real bugs in that migration, now fixed: the
definer functions that bypass RLS were reachable by `anon` (Supabase grants
`execute` to `anon` by default, so revoking from `public` did nothing), and the
policies were unscoped, which both required that grant and made anonymous
denial depend on an expression rather than on no policy matching.

Nothing in this app currently displays shipment data, real or otherwise.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:3400
```

Verify changes with a production build, **not** the dev server — Turbopack Fast
Refresh double-mounts and hides effect bugs:

```bash
npm run build && npm run start
```

Full gate:

```bash
npm run typecheck && npm run lint && npm run test && npm run verify:migrations
npm run verify:rls
```

`npm run test` covers `src/lib` only — 77 tests over the journey rules, board
ordering, formatting, role permissions and the database row mappers. That restriction is the layering contract enforced by the
test runner: if a rule needs a DOM or a database to test, it is in the wrong
layer.

Both `verify:` commands run against an in-process Postgres (PGlite — no server,
no port, no password, nothing to install).

- **`npm run verify:migrations`** — applies every migration from nothing and
  exercises what the DDL claims. **114 checks.** It cannot prove RLS: the role
  running it owns the tables, and an owner bypasses its own row-level security.
- **`npm run verify:rls`** — applies the same migrations, then drops to the
  `authenticated` role so every policy becomes live, and asserts what each kind
  of user can and cannot do. **74 checks.** This is the only thing here that can
  catch one tenant reading another's data.

`verify:rls` reproduces Supabase's roles, grants and `auth.uid()`; it is a
faithful model, not Supabase itself. Run the same scenarios against the real
project before the first paying customer.

---

## Setup

1. Copy `.env.example` to `.env.local`.
2. Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from
   your Supabase project under **Settings → API**.
3. Restart the dev server.

Until that is done the app renders a setup notice rather than a stack trace.

**There is no service-role key in this project and there must never be one.**
The anon key grants nothing by itself; every rule about who may read or write a
row is enforced by Row Level Security in the database.

### How people get access — an operational step, not a missing feature

There is no public sign-up button, deliberately. Access is granted by the
platform owner:

1. An invitation is created in the app, against an organisation and a role.
2. The owner creates the auth user in the Supabase dashboard under
   **Authentication → Users → Invite user**.
3. A database trigger converts any matching pending invitation into a
   membership when that user first appears.

A signed-in user with no membership lands on a "no access yet" page rather than
an empty dashboard.

This flow exists *because* there is no service-role key — creating users
programmatically would require one. The manual step is the price of not having
a key in the codebase that could expose every tenant, and it is worth paying.

---

## Architecture

Layering runs one way: `app → components → hooks → services → lib → types`.

- `src/lib/**` is pure — no Supabase, no `fetch`, no ambient clock. The journey
  rules live here so they can be unit-tested over fixed fixtures.
- `src/services/**` is the only code that talks to Supabase. It maps snake_case
  rows to the domain types in `src/types/domain.ts`.
- `src/components/**` renders props.

Full rules, including the RLS recursion trap and why `caller_org_ids()` exists,
are in [AGENTS.md](AGENTS.md).

## Documentation

| File | |
|---|---|
| [AGENTS.md](AGENTS.md) | The rulebook. Read before changing anything. |
| [docs/scope.md](docs/scope.md) | What V1 is, and what it deliberately is not. |
| [docs/open-questions.md](docs/open-questions.md) | What is still undecided. |
| [docs/going-live.md](docs/going-live.md) | **Steps to apply this to your real Supabase project.** |
| [docs/data-sources.md](docs/data-sources.md) | Where every coordinate came from, and how to regenerate it. |

## Stack

Next.js 16.2.10 (App Router) · React 19.2.4 · TypeScript · Tailwind v4 ·
Supabase (Postgres + Auth + RLS) · Vitest 3

Design tokens live in `src/app/globals.css` and nowhere else. There is no
`tailwind.config.*` file, by convention across all projects in this workspace.
