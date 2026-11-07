import { mapCheckpoint, type CheckpointRow } from "./mappers";
import { supabaseServer } from "./supabase/server";
import type { JourneyCheckpoint } from "@/types/domain";

/**
 * Recent checkpoints, for the activity stream.
 *
 * No organisation filter and no role check: RLS decides which rows come back,
 * exactly as everywhere else in `src/services`. A party organisation gets the
 * checkpoints of the shipments it holds a live grant for and nothing more —
 * the same policy that governs the journey view governs this.
 *
 * Only cleared checkpoints. A planned stage has not happened, so it has no
 * place in a stream of things that did.
 */

const CHECKPOINT_COLUMNS =
  "id, shipment_id, sequence_no, kind, label, location_id, latitude, longitude, planned_at, actual_at, exception_kind, note, recorded_at, sa_places(name, latitude, longitude)";

export async function loadRecentCheckpoints(limit = 40): Promise<JourneyCheckpoint[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("checkpoints")
    .select(CHECKPOINT_COLUMNS)
    .not("actual_at", "is", null)
    .order("actual_at", { ascending: false })
    .limit(limit);

  if (error) {
    // Never interpolate a row into an error: it can reach somebody who was
    // not permitted to read it.
    throw new Error(`Failed to load recent activity: ${error.message}`);
  }

  return ((data ?? []) as unknown as CheckpointRow[]).map(mapCheckpoint);
}
