import type { CheckpointException, CheckpointKind } from "@/types/domain";

import { supabaseServer } from "./supabase/server";

/**
 * Recording what happened on a journey.
 *
 * THIS IS THE ONLY WAY A CHECKPOINT ENTERS THE SYSTEM, and that is
 * deliberate. The human form calls `recordCheckpoint`; when a courier feed or
 * a carrier API arrives it calls the same function with the same shape. If
 * ingestion grows a second path, the two will validate differently, and the
 * difference will be discovered as inconsistent data months later.
 *
 * Note what is absent: no org_id filter, no role check. RLS decides whether
 * these writes land. A check here would look like defence in depth and would
 * actually hide a broken policy during testing.
 *
 * Also absent: `recorded_at` and `recorded_by`. A database trigger stamps
 * them, because the point of those columns is to record when the SYSTEM was
 * told — and a caller is not a reliable witness to that.
 */

/** Sequence numbers are gapped by 100 so a stage can be inserted between two. */
const SEQUENCE_STEP = 100;

export interface RecordCheckpointInput {
  shipmentId: string;
  orgId: string;
  kind: CheckpointKind;
  label: string;
  /** A gazetteer place. Coordinates come from it; nothing is geocoded. */
  saPlaceId: string | null;
  plannedAt: string | null;
  actualAt: string | null;
  exceptionKind: CheckpointException | null;
  note: string | null;
}

export interface RecordResult {
  ok: boolean;
  error: string | null;
}

function describe(message: string): string {
  // Postgres constraint names are not an error message for a dispatcher.
  if (message.includes("checkpoints_is_an_event")) {
    return "Give the stage either a planned time or an actual time.";
  }
  if (message.includes("checkpoints_sequence_unique")) {
    return "Another stage was added at the same position. Try again.";
  }
  if (message.includes("row-level security")) {
    return "You do not have permission to record stages on this shipment.";
  }
  return "Could not record the stage. Please try again.";
}

/**
 * The next free sequence number: the highest in use plus the gap.
 *
 * Read-then-write, so two operators logging at the same moment can collide.
 * The unique index on (shipment_id, sequence_no) catches that and the caller
 * is told to retry — which is the right trade. The alternative, a sequence or
 * a lock, would serialise every write to buy correctness that one retry
 * already provides.
 */
async function nextSequenceNo(shipmentId: string): Promise<number> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("checkpoints")
    .select("sequence_no")
    .eq("shipment_id", shipmentId)
    .order("sequence_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to read sequence: ${error.message}`);

  const highest = (data as { sequence_no: number } | null)?.sequence_no ?? 0;
  return highest + SEQUENCE_STEP;
}

export async function recordCheckpoint(
  input: RecordCheckpointInput
): Promise<RecordResult> {
  const label = input.label.trim();
  if (!label) return { ok: false, error: "Give the stage a name." };

  // The database enforces this too; saying it here produces a better message
  // than a constraint violation would.
  if (!input.plannedAt && !input.actualAt) {
    return {
      ok: false,
      error: "Give the stage either a planned time or an actual time.",
    };
  }

  const supabase = await supabaseServer();
  const sequenceNo = await nextSequenceNo(input.shipmentId);

  const { error } = await supabase.from("checkpoints").insert({
    shipment_id: input.shipmentId,
    org_id: input.orgId,
    sequence_no: sequenceNo,
    kind: input.kind,
    label,
    sa_place_id: input.saPlaceId,
    planned_at: input.plannedAt,
    actual_at: input.actualAt,
    exception_kind: input.exceptionKind,
    note: input.note?.trim() || null,
  });

  if (error) return { ok: false, error: describe(error.message) };
  return { ok: true, error: null };
}

/**
 * Confirm a planned stage actually happened.
 *
 * Separate from recording a new one because it is a different act: this is
 * an operator saying "the thing we expected has now occurred", and it must
 * not be able to invent a stage that was never planned.
 */
export async function confirmCheckpoint(input: {
  checkpointId: string;
  actualAt: string;
  exceptionKind: CheckpointException | null;
  note: string | null;
}): Promise<RecordResult> {
  const supabase = await supabaseServer();

  const { error } = await supabase
    .from("checkpoints")
    .update({
      actual_at: input.actualAt,
      exception_kind: input.exceptionKind,
      note: input.note?.trim() || null,
    })
    .eq("id", input.checkpointId);

  if (error) return { ok: false, error: describe(error.message) };
  return { ok: true, error: null };
}

export interface GazetteerPlace {
  id: string;
  name: string;
  kind: string;
}

/**
 * The whole gazetteer, for the stage picker.
 *
 * All 521 rows, loaded once with the page and filtered in the browser —
 * roughly 8KB over the wire. The alternative is a round trip per keystroke,
 * which is slower for the operator and more code for us, to save a few
 * kilobytes. If the gazetteer ever grows past a few thousand rows this should
 * become a search endpoint.
 */
export async function loadPlaces(): Promise<GazetteerPlace[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("sa_places")
    .select("id, name, kind")
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to load places: ${error.message}`);
  return (data ?? []) as GazetteerPlace[];
}
