import type { MembershipRole } from "@/types/domain";

import { fail } from "./fail";
import { supabaseServer } from "./supabase/server";

/**
 * Who is on a shipment.
 *
 * This is the read path that decides what every non-admin sees, so it is also
 * the one place where a well-meant `.eq("org_id", …)` would do real harm: it
 * would hide a broken policy during testing, and the day somebody removed the
 * filter the leak would already be live. RLS is the boundary;
 * `npm run verify:rls` proves it.
 *
 * The NAMES are the awkward part. `shipment_assignments` holds user ids, and
 * the names behind them live in `auth.users` and `profiles`, which RLS keeps
 * own-row-only on purpose. They are fetched through the `org_members` RPC —
 * which refuses anyone who is not an admin of that organisation — and joined
 * here. That is why this screen is admin-only: not to hide anything, but
 * because nobody else can resolve a user id to a person.
 */

export interface AssignmentRow {
  id: string;
  shipmentId: string;
  userId: string;
  createdAt: string;
}

export interface Assignee {
  assignmentId: string;
  userId: string;
  /** Null when the person has not filled in a profile name yet. */
  fullName: string | null;
  email: string;
  role: MembershipRole;
  assignedAt: string;
}

export interface WriteResult {
  ok: boolean;
  error: string | null;
}

const ASSIGNMENT_COLUMNS = "id, shipment_id, user_id, created_at";

function describe(message: string, fallback: string): string {
  if (message.includes("row-level security")) {
    return "Only an admin of this organisation can change who is on a shipment.";
  }
  if (message.includes("shipment_assignments_guard_assignee")) {
    return "That person is not in this organisation.";
  }
  if (message.includes("shipment_assignments_active_idx")) {
    return "They are already on this shipment.";
  }
  return fallback;
}

/** The live assignments on one shipment, as user ids. */
export async function listAssignments(shipmentId: string): Promise<AssignmentRow[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("shipment_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("shipment_id", shipmentId)
    .is("unassigned_at", null)
    .order("created_at", { ascending: true });

  if (error) fail("load assignments", error);

  type Row = {
    id: string;
    shipment_id: string;
    user_id: string;
    created_at: string;
  };

  return ((data ?? []) as unknown as Row[]).map((row) => ({
    id: row.id,
    shipmentId: row.shipment_id,
    userId: row.user_id,
    createdAt: row.created_at,
  }));
}

/**
 * Put somebody on a shipment.
 *
 * `assignedBy` comes from the session, and the insert policy checks it against
 * `auth.uid()` as well — so a forged assigner is refused by the database even
 * if this were called wrongly. Passing it from the session means that never
 * has to be the last line of defence.
 */
export async function assignShipment(input: {
  orgId: string;
  shipmentId: string;
  userId: string;
  assignedBy: string;
}): Promise<WriteResult> {
  if (!input.userId) return { ok: false, error: "Choose somebody first." };

  const supabase = await supabaseServer();
  const { error } = await supabase.from("shipment_assignments").insert({
    org_id: input.orgId,
    shipment_id: input.shipmentId,
    user_id: input.userId,
    assigned_by: input.assignedBy,
  });

  if (error) {
    return { ok: false, error: describe(error.message, "Could not assign the shipment.") };
  }
  return { ok: true, error: null };
}

/**
 * Take somebody off.
 *
 * An UPDATE, never a DELETE: who could see a load, and when, is part of the
 * oversight record. The time itself is stamped by the database — the value
 * sent here is only the signal that the assignment has ended.
 */
export async function endAssignment(assignmentId: string): Promise<WriteResult> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("shipment_assignments")
    .update({ unassigned_at: new Date().toISOString() })
    .eq("id", assignmentId)
    .is("unassigned_at", null)
    .select("id");

  if (error) {
    return { ok: false, error: describe(error.message, "Could not end the assignment.") };
  }
  // A `using` failure does not raise — the update simply matches no rows. An
  // operator calling this endpoint directly would otherwise be told it worked.
  if (!data || data.length === 0) {
    return { ok: false, error: "That assignment is not yours to end." };
  }

  return { ok: true, error: null };
}
