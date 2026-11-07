# Implementation report

Covering the audit-trail, lifecycle-guard and fleet-wiring work. Written at the
point where the code is finished and verified against a rebuilt schema, and
**one manual step away from working against the live project.**

---

## 1. What was built

**`0012_audit_and_guards.sql`** — three things the application is deliberately
not trusted with.

- `decision_logs`, an append-only operational history, plus the
  `decision_action` enum (14 values) and two indexes: by shipment for "show me
  this load's history", by org for "what happened today".
- `write_decision_log()`, `security definer` with a pinned `search_path` and
  `execute` revoked from `public`, `anon` and `authenticated`. The audit
  triggers on `shipments`, `shipment_assignments`, `shipment_parties` and
  `checkpoints` are its only callers.
- `shipments_guard_transition()` — a load cannot be delivered before it was
  dispatched; only an admin may reopen a delivered load or reinstate a
  cancelled one.
- `shipment_assignments_guard_coverage()` — an **active** shipment cannot lose
  its last operator. A delivered or cancelled one can.

**The fleet link, wired end to end.** `shipments.driver_id` / `vehicle_id` have
existed since `0011` and were read by nothing. They now run the whole way:
`types/domain.ts` → `services/mappers.ts` → `services/shipments.ts` →
`app/(app)/shipments/form-fields.ts` → the form.

**The pickers.** `FleetField` in `shipment-form.tsx` offers the fleet and keeps
a free-text fallback, because subcontracted trucks and hired-in drivers are
ordinary in road freight and a picker that only offered fleet rows would make
those loads unrecordable. Exactly one of the id and the text posts.

**The history panel.** `services/history.ts` reads the trail,
`lib/history.ts` turns a line into a sentence (pure, 14 unit tests), and
`components/journey/history-panel.tsx` renders it on the shipment page.

---

## 2. What is enforced where

Everything that matters is enforced **in the database**, not in the UI.

| Rule | Where |
|---|---|
| An admin sees the org; everyone else sees what they are assigned | `can_view_shipment()`, `0008` |
| The trail is scoped to loads you may see | `decision_logs_select_member`, `0012` |
| The trail cannot be written, edited or deleted | no insert/update/delete policy at all |
| The trail cannot be forged via the writer | `execute` revoked from `authenticated` |
| A load keeps an operator while it is active | `shipment_assignments_guard_coverage` |
| No delivery before dispatch | `shipments_guard_transition` |
| One tenant cannot name another's driver | composite FK `(driver_id, org_id)` |

`decision_logs` has **one** policy and its command is `SELECT`. The triggers
write it, inside the transaction that made the change; nothing in `src/` can
add a line, so nothing can tidy one away.

---

## 3. Three judgement calls, stated rather than buried

**The service resolves the fleet row's name itself** instead of accepting a
display name posted beside the id. One extra read, and the alternative is that
the permanent record of who drove a load is a string the browser sent — the day
the two disagree, the audit trail becomes an opinion.

**`cargo_value` is shown in the trail, not censored.** Anybody reading it can
already see the value on the shipment above. Hiding it only here would cost the
reader the change most worth querying while protecting nothing. The real
protections are that the trigger records only the columns that moved rather
than copying whole rows, and that `can_view_shipment` gates the table.

**A null actor is reported as "Outside the app."** `auth.uid()` is null for a
migration or the SQL editor. Attributing those to a person would put a false
line in an audit trail, which is worse than a missing one.

---

## 4. Two real bugs found by the verification suites

**The transition guard was dead.** The delivery-before-dispatch rule sat below
the `auth.uid() is null` early return that the role checks need, so it never
ran for any caller without a session. The `0004` check constraint does not
cover the case — it short-circuits on `dispatched_at is null`, so a delivery
with no dispatch at all passes it. A fact about the row now goes above the
question about the caller. Recorded as non-negotiable 9.

**The coverage guard bit two existing test scenarios**, in
`verify-behaviour-4-assignment.sql` and `verify-rls.mjs`. Both withdrew the
only operator from an active shipment. That is the guard working: both now
assign a second person first, and `verify-rls.mjs` additionally asserts the
withdrawal of the last one is still refused.

---

## 5. Verified

```
typecheck            clean
lint                 clean
test                 209 passed  (17 files)
verify:migrations    257 checks
verify:rls           157 checks
build                clean, 20 routes
verify:upgrade       apply-0008-0012.sql safe against a project at 0007
```

New coverage: 17 behaviour assertions in `verify-behaviour-8-audit.sql`, 10 RLS
scenarios for `decision_logs`, 14 unit tests for `lib/history.ts`, 6 for
`isSchemaBehind`, 5 for `lib/verdicts.ts`.

**Applied to the live project on 2026-11-06** (0008–0012, pasted by the owner).

Verified in the browser against the live project, signed in:

- Every route returns 200. `/operators` redirects to `/team`, by design.
- The **driver and vehicle pickers read real fleet rows** — driver "Thabang",
  vehicle "ND 587-968". Selecting a fleet driver hides the free-text input, so
  exactly one of `driverId` and `driverName` posts.
- The **history panel renders**, with its empty state on `N3-0097`. That
  shipment predates `0012`, so an empty trail is the correct answer rather
  than a failure.

---

## 6. The authorised test edit, and what it exposed

With the owner's go-ahead, one note was written to `N3-0097` through the edit
form. **It saved, and the history panel stayed empty.** Two separate defects.

### 6a. The trail was watching three columns

`shipments_audit` in `0012` compared `reference`, `promised_delivery_date` and
the two endpoints — and nothing else. An edit to the cargo value, weight,
carrier, driver, vehicle, goods, either planned time, the silence threshold or
the notes changed the shipment and **left no line at all.** The table, the
writer and the trigger were all correct; they just did not look at most of the
row.

`verify-behaviour-8-audit.sql` missed it because its edit changed `reference`,
one of the three watched columns. **A test that proves the mechanism is not a
test that proves the coverage.**

`0013_audit_every_column.sql` stops enumerating: it diffs `to_jsonb(old)`
against `to_jsonb(new)` and records every key that moved, excluding identity,
the lifecycle timestamps reported as their own actions, and the
trigger-maintained counters. A column added by a later migration is now
audited the day it exists.

The new assertions were confirmed to **fail without `0013` and pass with it** —
checked by moving the migration aside and re-running.

### 6b. The edit form was deleting data

`plannedDispatchAt` and `plannedDeliveryAt` had their defaults hardcoded to
`""`. The inputs rendered blank but still posted, `readShipment` read them back
as null, and **saving any change to a shipment wiped both planned times** —
including the ETA the board shows. `N3-0097` had dispatch 17 Nov 14:48 and
delivery 26 Nov 13:47; a single edit would have erased them.

Blank was the right instinct — the stored value is a UTC instant, the input
wants the operator's wall clock, and rendering one as the other shows a South
African dispatcher a time two hours out. But a blank field on a form that posts
is not a missing value, it is a deletion. `dateTimeLocalIn` in `src/lib/date.ts`
does the conversion properly, with a round-trip test.

This one was caught *before* saving, by reading the defaults rather than
trusting them.

### 6c. A legacy value that rendered as its own opposite

`0012` wrote the endpoints as `"route": "changed"` — a bare string, not a
`{from, to}` pair. Those rows are in the trail permanently, because the trail
cannot be rewritten, and `changedFields` read `.from` off a string and rendered
"Route: not set → not set". Now rendered as "Route changed".

---

## 7. Still not verified

**That the trail records an ordinary edit, on the live project.** `0013` is
written, verified and bundled as `supabase/apply-0013.sql`, but **not applied**
— it needs one more paste. Until then the live trail still watches three
columns.

Everything else in section 5 was verified against live. The two lifecycle
guards remain unreachable through the interface, by design: the shipment page
offers only "Mark dispatched" for an undispatched load, never "Mark
delivered", so the illegal transition cannot be attempted from the UI.

Also found: `decision_logs.created_at` defaulted to `now()`, the transaction
start, so several lines written together carried identical stamps and ordered
arbitrarily — the panel could show an effect above its cause. `0013` changes
the default to `clock_timestamp()`. Existing rows keep their stamps; rewriting
them would be falsifying the trail to make it tidier.

---

## 8. Not done

Still untouched from the wider specification:

- **Exception resolution lifecycle.** `exception_kind` is recorded on
  checkpoints; nothing resolves one or tracks who did.
- **Notifications.** No delivery mechanism exists.
- **Realtime subscriptions.** The board is request-scoped; there is no
  subscription.
- **Document uploads.** No Storage bucket, no policies.
- **Duplicate-submission protection.** A double-submitted form can write
  twice; only `shipments_org_reference_idx` stops the obvious case.
- **`exception_reported`** is in the `decision_action` enum with no trigger
  writing it yet — deliberate, so the lifecycle work does not need a migration
  to add the value.
