import { supabaseServer } from "./supabase/server";

/**
 * Emptying an organisation, so real data can go in.
 *
 * NO MIGRATION IS NEEDED FOR ANY OF THIS, and establishing that was the whole
 * point. `shipments_delete_admin` has existed since 0004 and
 * `announcements_update_admin` since 0007, so an admin can clear their own
 * organisation against the schema they already have. Routing this through
 * "delete the demo organisation", which needs 0010, made a one-click job wait
 * on a SQL paste for no reason.
 *
 * WHAT IT CLEARS, and why that is exactly the board and the Live Feed:
 *
 *   Shipments are DELETED. The cascade takes their checkpoints (0004), party
 *   grants (0005), messages and shipment-linked tasks (0007), and assignments
 *   (0008, when it exists). One delete, five tables.
 *
 *   Announcements are RETRACTED, not deleted — they have no delete policy,
 *   because this project ends things with a timestamp. `loadAnnouncements`
 *   filters on `retracted_at`, so a retracted notice leaves the feed.
 *
 * Every item in the Live Feed comes from one of those two places — notices,
 * cleared checkpoints, and shipment lifecycle timestamps — so when both are
 * gone the feed is empty, not merely quiet.
 *
 * WHAT IT KEEPS: places, people, invitations, and the organisation itself.
 * Clearing the loads is not the same as dismantling the business, and a
 * control that did both would be a control nobody could safely press.
 */

export interface ClearResult {
  ok: boolean;
  error: string | null;
  shipmentsDeleted: number;
  announcementsRetracted: number;
}

export interface ClearCounts {
  shipments: number;
  announcements: number;
}

/** What pressing the button would remove, so it can be said before it is done. */
export async function countClearableData(): Promise<ClearCounts> {
  const supabase = await supabaseServer();

  const [shipments, announcements] = await Promise.all([
    supabase.from("shipments").select("id", { count: "exact", head: true }),
    supabase
      .from("announcements")
      .select("id", { count: "exact", head: true })
      .is("retracted_at", null),
  ]);

  return {
    shipments: shipments.count ?? 0,
    announcements: announcements.count ?? 0,
  };
}

export async function clearOrganisationData(input: {
  orgId: string;
  userId: string;
}): Promise<ClearResult> {
  const supabase = await supabaseServer();
  const empty = { shipmentsDeleted: 0, announcementsRetracted: 0 };

  // THE ORG FILTER IS HERE DELIBERATELY, against the house rule that service
  // code must not add one.
  //
  // That rule exists so a broken policy shows up in testing instead of being
  // masked by a filter. It is the right rule for a read. This is an
  // IRREVERSIBLE BULK DELETE, where the cost of a policy being wrong is
  // another tenant's shipments, and the cost of the belt-and-braces is one
  // redundant predicate. `shipments_delete_admin` is still the boundary and
  // `verify:rls` still proves it; this is the second lock on the one door
  // where a mistake cannot be undone.
  const { data: deleted, error: deleteError } = await supabase
    .from("shipments")
    .delete()
    .eq("org_id", input.orgId)
    .select("id");

  if (deleteError) {
    if (deleteError.message.includes("row-level security")) {
      return {
        ok: false,
        error: "Only an admin of this organisation can clear its data.",
        ...empty,
      };
    }
    return { ok: false, error: "Could not clear the shipments.", ...empty };
  }

  const shipmentsDeleted = deleted?.length ?? 0;

  const { data: retracted, error: retractError } = await supabase
    .from("announcements")
    .update({ retracted_at: new Date().toISOString(), retracted_by: input.userId })
    .eq("org_id", input.orgId)
    .is("retracted_at", null)
    .select("id");

  if (retractError) {
    // The shipments ARE gone by now. Say so rather than reporting a blanket
    // failure that would send somebody looking for data that is not there.
    return {
      ok: false,
      error:
        `${shipmentsDeleted} shipments were removed, but the notices could ` +
        `not be retracted. They will still show in the feed.`,
      shipmentsDeleted,
      announcementsRetracted: 0,
    };
  }

  return {
    ok: true,
    error: null,
    shipmentsDeleted,
    announcementsRetracted: retracted?.length ?? 0,
  };
}
