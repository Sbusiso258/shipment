# Scope — Shipment Oversight V1

Settled 2026-11-03 with the owner.

## Positioning

A standalone venture, separate from the other businesses in this workspace. The
owner is **not** running a logistics business. In their words:

> "we are not running any logistics business but rather we are a shipment
> oversight. we assist in your viewing the shipment and what has been done by
> your business in ensuring a smoother delivery."

So the customer is a logistics business, and the product is the visibility layer
over what that business is already doing.

## The one thing V1 must do well

Show a single shipment's route from the start of delivery to the end of it, with
everything in between visible: where it is now, what it has cleared, what it is
waiting on, and whether it is late.

Everything else in V1 exists only to make that view possible and trustworthy.

## Confirmed decisions

| | |
|---|---|
| Data | Server-hosted — customers use the product online |
| Backend | Supabase (Postgres + Auth + RLS); project already exists |
| Map | Required in V1. MapLibre GL + OpenFreeMap vector tiles — free, no key, no commercial restriction |
| Geography | South Africa domestic. Cross-border modelled for, not built |
| Access | Owner-controlled provisioning. No public sign-up |
| Cargo value | Optional column, hidden unless filled |
| Port | 3400 |

## Who uses it

- **Logistics businesses** — the operators running the shipments. The paying
  customer. Roles: `admin`, `operator`.
- **Other parties on a shipment** — consignor, consignee, broker. They see where
  the load is. Role: `viewer`. **They read; they never write.** That asymmetry
  is the product.
- **The platform owner** — authorises who gets into the system. Held in a
  separate `platform_admins` table, not as a role string on a membership, so
  platform power cannot be reached by editing an org-scoped row.

## In V1

- The shipment journey view: ordered checkpoints, origin to destination, with
  current position, planned vs actual, and late or exception stages made loud.
- A route map showing the real geography of the journey.
- A shipment list and an oversight board that surfaces trouble first.
- Checkpoint logging.
- Owner-controlled provisioning of organisations and members.

## Deliberately not in V1

### The Live Feed and Tasks panel — built, and deliberately not mounted

Settled with the owner on 2026-11-10, and recorded because it looks exactly
like an oversight and has been rediscovered as one twice.

`src/components/feed/feed-panel.tsx` is complete — three Radix tabs over a
live feed, recent messages and tasks, with a shared composer. So are its
children (`messages-tab.tsx`, `tasks-tab.tsx`, `panel-composer.tsx`,
`panel-form-state.ts`), `src/lib/feed.ts`'s `buildFeed()` and its unit tests,
and the services behind them (`postAnnouncement`, `createTask`,
`setTaskStatus`, `loadTasks`, `loadAnnouncements`).

**Nothing imports any of it.** It was on the dashboard and the owner asked for
it to be taken off; asked later where it should live instead, the answer was
to leave it out. So it is not a gap and it is not half-finished work — it is a
feature that was removed from the product.

Consequences worth knowing before anybody "fixes" this:

- Three dependencies exist only for it — `@radix-ui/react-tabs` directly, and
  `@radix-ui/react-dialog` and `@radix-ui/react-select` are unused by anything
  at all. Removing the panel would make all three droppable.
- `announcements` and `tasks` are real tables with real RLS policies and no UI
  path. `/admin/setup`'s clear-data step still counts and retracts
  announcements, so the table is not inert.
- Wiring it up needs only three server actions (`announce`, `createTask`,
  `toggleTask`) and somewhere to mount it. That is a short job if the decision
  is ever reversed — which is the reason to leave the components in place
  rather than delete them.

### The rest

Each has a seam left for it, described in `AGENTS.md`:

- Courier and freight-forwarder API integrations. Checkpoint ingestion is
  written as one service function so a feed can later call the same path a human
  form does.
- A public client-facing tracking link. Party-level visibility already exists as
  a permission, so the portal is a new policy rather than a rebuild.
- Inbound PO and container tracking; outbound proof of delivery.
- Customs and border stages. The journey is an ordered list of event rows
  precisely so these are new enum values, not a schema rebuild.
- Billing. Mobile app.

## What "oversight" shouts about

An operator opening the board should immediately see:

1. Shipments past a promised delivery day with nothing delivered
2. Shipments at risk — not late yet, but the next checkpoint is already overdue
3. Shipments silent — no update logged within the organisation's threshold
4. Shipments with an open exception

Exactly one verdict badge per row, by precedence. A row with four badges
communicates nothing.

## What it will not do

Stated here because each is tempting and each would damage the product:

- **No interpolated truck position.** A shipment is drawn at its last confirmed
  checkpoint, never at a plausible midpoint. An interpolated dot is a fabricated
  GPS fix.
- **No guessed ETAs.** A stage with no planned time says so.
- **No invented coordinates.** Location coordinates come from an attributed open
  dataset or from an operator pasting a real pin.
