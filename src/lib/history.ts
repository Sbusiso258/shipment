import type { DecisionAction, DecisionLogEntry } from "@/types/domain";

/**
 * Turning an audit line into a sentence.
 *
 * Pure, and therefore here rather than in the component: "what does this line
 * mean" is a judgement, and `AGENTS.md` keeps judgements out of components so
 * they can be tested over fixtures. No clock — the caller passes the reference
 * date in, same as `journey.ts`.
 */

/**
 * ENUM VALUES ARE NOT SENTENCES. `operator_withdrawn` is a column value; "Took
 * an operator off the load" is what happened. Rendering the raw value with the
 * underscores swapped for spaces reads like a database to the one audience —
 * ops staff under pressure — least able to spare the attention.
 */
const PHRASES: Record<DecisionAction, string> = {
  shipment_created: "Recorded this shipment",
  shipment_updated: "Edited the shipment",
  shipment_dispatched: "Marked it dispatched",
  shipment_delivered: "Marked it delivered",
  shipment_cancelled: "Cancelled it",
  shipment_held: "Put it on hold",
  shipment_resumed: "Took it off hold",
  operator_assigned: "Put an operator on the load",
  operator_withdrawn: "Took an operator off the load",
  party_granted: "Gave a customer visibility",
  party_revoked: "Withdrew a customer's visibility",
  checkpoint_recorded: "Added a stage",
  checkpoint_confirmed: "Confirmed a stage",
  exception_reported: "Reported an exception",
};

export function describeAction(action: DecisionAction): string {
  // A new enum value reaching a build without a phrase should not render
  // blank. The `Record` makes that a type error, so this is only reachable
  // from data a future migration added — where the raw value is still more
  // use than nothing.
  return PHRASES[action] ?? action;
}

/**
 * Which actions are corrections rather than progress.
 *
 * These are the lines somebody reviewing a disputed delivery actually looks
 * for, so the panel marks them instead of making the reader spot them.
 */
const CORRECTIONS: ReadonlySet<DecisionAction> = new Set<DecisionAction>([
  "shipment_updated",
  "shipment_cancelled",
  "shipment_resumed",
  "operator_withdrawn",
  "party_revoked",
]);

export function isCorrection(action: DecisionAction): boolean {
  return CORRECTIONS.has(action);
}

/** One changed field, ready to render. */
export interface ChangedField {
  field: string;
  from: string;
  to: string;
}

/**
 * Columns that are noise rather than news.
 *
 * Only these two, and neither is hidden for secrecy: `org_id` cannot change
 * without the tenant guard refusing it, and `created_by` never changes at
 * all, so a line about either is a line about nothing.
 *
 * `cargo_value` deliberately IS shown. Anybody reading this trail can already
 * see it on the shipment above, and a field censored here but printed there
 * would be privacy theatre — it would cost the reader the one change most
 * worth querying while protecting nothing. The real protection is that the
 * trigger records only the columns that moved instead of copying whole rows,
 * and that `can_view_shipment` gates the whole table.
 */
const HIDDEN = new Set(["org_id", "created_by"]);

const FIELD_NAMES: Record<string, string> = {
  reference: "Reference",
  direction: "Direction",
  mode: "Method",
  status: "Status",
  origin_location_id: "Origin",
  destination_location_id: "Destination",
  carrier_name: "Carrier",
  driver_id: "Driver",
  vehicle_id: "Vehicle",
  driver_name: "Driver",
  vehicle_registration: "Vehicle",
  goods_description: "Goods",
  cargo_value: "Cargo value",
  weight_kg: "Weight",
  planned_dispatch_at: "Planned dispatch",
  planned_delivery_at: "Planned delivery",
  promised_delivery_date: "Promised by",
  dispatched_at: "Dispatched",
  delivered_at: "Delivered",
  cancelled_at: "Cancelled",
  silence_threshold_days: "Silence threshold",
  notes: "Notes",
  unassigned_at: "Taken off",
  party_role: "Customer role",
  // 0012 wrote the two endpoints under this single key.
  route: "Route",
};

/**
 * NULL IS NOT AN EMPTY STRING HERE.
 *
 * Several columns in this schema carry meaning in being null — `cargo_value`
 * null means NOT DISCLOSED and `promised_delivery_date` null means no promise
 * was made. Rendering those as a blank would turn "nobody said" into "it was
 * cleared", which is the same class of mistake as writing 0 for an
 * undisclosed value.
 */
function show(value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (value === "") return "blank";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * The `changed` object, flattened for display and ordered the way the form is.
 *
 * An id-valued column (`driver_id`, `origin_location_id`) is reported as
 * having changed WITHOUT the raw uuids: "Driver changed" is the useful part,
 * and two uuids side by side are noise that nobody can read. Resolving them to
 * names would mean a query per line on a page that already has enough.
 */
export function changedFields(entry: DecisionLogEntry): ChangedField[] {
  if (!entry.changed) return [];

  const fields: ChangedField[] = [];

  for (const [column, move] of Object.entries(entry.changed)) {
    if (HIDDEN.has(column)) continue;

    const label = FIELD_NAMES[column] ?? column.replace(/_/g, " ");

    // An id is reported as having changed WITHOUT the raw uuids: "Driver
    // changed" is the useful part, and two uuids side by side are noise.
    //
    // A value that is not a `{ from, to }` object is treated the same way.
    // `0012` wrote the endpoints as `"route": "changed"` — a bare string — and
    // rows written by it are still in the trail, permanently, because the
    // trail cannot be rewritten. Reading `.from` off a string yields undefined
    // and rendered as "route: not set → not set", which says the opposite of
    // what happened.
    const shaped =
      typeof move === "object" && move !== null && ("from" in move || "to" in move);
    const opaque = column.endsWith("_id") || !shaped;

    fields.push({
      field: label,
      from: opaque ? "" : show(move.from),
      to: opaque ? "" : show(move.to),
    });
  }

  return fields.sort((a, b) => a.field.localeCompare(b.field));
}

/**
 * Who did it, in words.
 *
 * A null actor is a real and ordinary case — a migration, the SQL editor, a
 * future batch job — and it gets said plainly rather than dressed up as a
 * person. An actor whose membership has since gone is "a former member": they
 * did act, and erasing them would be rewriting the trail.
 */
export function describeActor(
  actorId: string | null,
  names: Readonly<Record<string, string>>,
  viewerId?: string
): string {
  if (actorId === null) return "Outside the app";
  if (viewerId && actorId === viewerId) return "You";
  return names[actorId] ?? "A former member";
}
