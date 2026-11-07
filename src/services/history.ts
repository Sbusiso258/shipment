import { fail } from "./fail";
import { supabaseServer } from "./supabase/server";
import type { DecisionAction, DecisionLogEntry } from "@/types/domain";

/**
 * Reading the audit trail.
 *
 * No organisation filter and no role check, like every other read in
 * `src/services` — `decision_logs_select_member` decides what comes back. That
 * policy is `is_org_member(org_id)` AND `can_view_shipment(shipment_id)`, so
 * an operator gets the history of the loads they are on and nothing else, and
 * a party organisation gets nothing at all: the trail records who inside the
 * carrier decided what, which is the carrier's business and not the customer's.
 *
 * There is no write function here on purpose. The trail is written by the
 * triggers in `0012`, inside the transaction that made the change, and the
 * table has no insert policy — so a line cannot be added, edited or removed
 * from the application at all. Adding a writer here would mean adding that
 * policy, and an audit trail the application can write is an audit trail the
 * application can rewrite.
 */

const COLUMNS =
  "id, org_id, actor_id, action, subject_table, subject_id, shipment_id, changed, reason, created_at";

interface DecisionLogRow {
  id: string;
  org_id: string;
  actor_id: string | null;
  action: DecisionAction;
  subject_table: string;
  subject_id: string;
  shipment_id: string | null;
  changed: Record<string, { from: unknown; to: unknown }> | null;
  reason: string | null;
  created_at: string;
}

function mapEntry(row: DecisionLogRow): DecisionLogEntry {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    action: row.action,
    subjectTable: row.subject_table,
    subjectId: row.subject_id,
    shipmentId: row.shipment_id,
    changed: row.changed,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

/**
 * One load's history, newest first.
 *
 * `limit` is a guard rather than a page. A shipment that has accumulated more
 * than this many decisions is a shipment somebody should be looking at in a
 * report, not scrolling past on a detail page — and an unbounded read here
 * would be the one query that gets slower for the whole life of the account.
 */
export async function loadShipmentHistory(
  shipmentId: string,
  limit = 50
): Promise<DecisionLogEntry[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("decision_logs")
    .select(COLUMNS)
    .eq("shipment_id", shipmentId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) fail("load the shipment history", error);

  return ((data ?? []) as unknown as DecisionLogRow[]).map(mapEntry);
}
