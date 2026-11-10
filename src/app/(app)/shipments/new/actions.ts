"use server";

import { revalidatePath } from "next/cache";

import { submittedValues } from "@/lib/form-values";
import { canEditShipments } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { recordCheckpoint } from "@/services/checkpoints";
import { createShipment } from "@/services/shipments";

import { readShipment, readStages } from "../form-fields";

/**
 * Recording a new shipment, and the route it is expected to take.
 *
 * Re-establishes who is asking, as every action here does: a server action is
 * a public HTTP endpoint, so the screen's role check protects the screen, not
 * this. RLS refuses the write regardless.
 */

export type { ShipmentFormState } from "@/components/shipments/shipment-form-state";

import type { ShipmentFormState } from "@/components/shipments/shipment-form-state";

export async function createShipmentAction(
  _prev: ShipmentFormState,
  form: FormData
): Promise<ShipmentFormState> {
  const session = await requireSession();

  // EVERY FAILURE PATH HANDS THE TYPING BACK. A bare `{ ok: false, error }`
  // is what made one duplicate reference erase fourteen fields.
  const failed = (error: string): ShipmentFormState => ({
    ok: false,
    error,
    values: submittedValues(form),
    attempt: (_prev.attempt ?? 0) + 1,
  });

  if (!canEditShipments(session.activeRole)) {
    return failed("Your role cannot record shipments.");
  }

  const stages = readStages(form);

  // A checkpoint needs a planned or an actual time — non-negotiable #11, and a
  // check constraint. These are all planned, so a row without one would be
  // rejected AFTER the shipment was created. Say so first.
  const timeless = stages.filter((stage) => stage.plannedAt === null);
  if (timeless.length > 0) {
    return failed(
      "Give every stage a planned time, or remove it: " +
        timeless.map((s) => s.label).join(", ")
    );
  }

  const created = await createShipment({
    ...readShipment(form),
    orgId: session.activeOrg.id,
    createdBy: session.userId,
  });

  if (!created.ok || !created.shipmentId) {
    return failed(created.error ?? "Could not save the shipment.");
  }

  // THE SHIPMENT EXISTS NOW. PostgREST gives no multi-statement transaction,
  // so the stages are separate writes and one can fail on its own. A partial
  // save is reported rather than smoothed over: the operator is told exactly
  // which stages are missing so they can add them, because a route with a
  // silently dropped stage is a lie about the journey.
  const unsavedStages: string[] = [];

  for (const stage of stages) {
    const result = await recordCheckpoint({
      shipmentId: created.shipmentId,
      orgId: session.activeOrg.id,
      kind: stage.kind,
      label: stage.label,
      saPlaceId: stage.saPlaceId,
      plannedAt: stage.plannedAt,
      actualAt: null,
      exceptionKind: null,
      note: null,
    });

    if (!result.ok) unsavedStages.push(stage.label);
  }

  revalidatePath("/");
  revalidatePath(`/shipments/${created.shipmentId}`);

  // Nothing carried back on success: the form SHOULD clear, and the bumped
  // `attempt` is what remounts it empty.
  return {
    ok: true,
    error: null,
    unsavedStages,
    attempt: (_prev.attempt ?? 0) + 1,
  };
}
