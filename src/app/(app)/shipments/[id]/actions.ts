"use server";

import { revalidatePath } from "next/cache";

import {
  canAssignShipments,
  canEditShipments,
  canLogCheckpoints,
  canManageParties,
} from "@/lib/roles";
import { submittedValues } from "@/lib/form-values";
import { assignShipment, endAssignment } from "@/services/assignments";
import { requireSession } from "@/services/bootstrap";
import {
  confirmCheckpoint,
  recordCheckpoint,
  type RecordResult,
} from "@/services/checkpoints";
import {
  findCounterparty,
  grantParty,
  revokeParty,
  setPartyMessaging,
} from "@/services/parties";
import {
  applyLifecycleEvent,
  updateShipment,
  type LifecycleEvent,
} from "@/services/shipments";
import type {
  CheckpointException,
  CheckpointKind,
  PartyRole,
} from "@/types/domain";

import { instant as readInstant, readShipment } from "../form-fields";

/**
 * Server actions for the journey page.
 *
 * Each one re-establishes who is asking. A server action is a public HTTP
 * endpoint — it can be invoked directly, not only by the form that renders
 * it — so trusting anything the client sent about identity or permissions
 * would be trusting the attacker.
 *
 * The role check here is still not the boundary. RLS is. This exists so a
 * viewer gets a clear refusal rather than a policy violation they cannot
 * interpret.
 */

/**
 * A "use server" module may only export async functions — every export becomes
 * a callable endpoint, so a plain object cannot live here. The type is fine
 * (types are erased), but the initial state constant lives with the form that
 * uses it, in `checkpoint-form-state.ts`.
 */
export type { CheckpointFormState } from "@/components/journey/checkpoint-form-state";
export type { AssignmentFormState } from "@/components/journey/assignment-form-state";
export type { ShipmentFormState } from "@/components/shipments/shipment-form-state";
export type { PartyFormState } from "@/components/parties/party-form-state";

import type { AssignmentFormState } from "@/components/journey/assignment-form-state";
import type { PartyFormState } from "@/components/parties/party-form-state";
import type { ShipmentFormState } from "@/components/shipments/shipment-form-state";
import type { CheckpointFormState } from "@/components/journey/checkpoint-form-state";

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `datetime-local` gives wall-clock text with no zone. Interpreting it in the
 * server's zone would be wrong — the server runs UTC and the operator does
 * not — so the browser sends the resolved ISO instant alongside it, and this
 * is the only value trusted.
 */
function instant(form: FormData, name: string): string | null {
  const iso = field(form, name);
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function recordStage(
  shipmentId: string,
  _prev: CheckpointFormState,
  form: FormData
): Promise<CheckpointFormState> {
  const session = await requireSession();

  if (!canLogCheckpoints(session.activeRole)) {
    return { ok: false, error: "Your role cannot record stages." };
  }

  const exception = field(form, "exceptionKind") as CheckpointException | null;

  const result: RecordResult = await recordCheckpoint({
    shipmentId,
    orgId: session.activeOrg.id,
    kind: (field(form, "kind") ?? "linehaul") as CheckpointKind,
    label: field(form, "label") ?? "",
    saPlaceId: field(form, "saPlaceId"),
    plannedAt: instant(form, "plannedAt"),
    actualAt: instant(form, "actualAt"),
    exceptionKind: exception,
    note: field(form, "note"),
  });

  if (!result.ok) return { ok: false, error: result.error };

  // The journey, the board and the shipment's own counters all change when a
  // stage is recorded.
  revalidatePath(`/shipments/${shipmentId}`);
  revalidatePath("/");

  return { ok: true, error: null };
}

export async function confirmStage(
  shipmentId: string,
  _prev: CheckpointFormState,
  form: FormData
): Promise<CheckpointFormState> {
  const session = await requireSession();

  if (!canLogCheckpoints(session.activeRole)) {
    return { ok: false, error: "Your role cannot record stages." };
  }

  const checkpointId = field(form, "checkpointId");
  if (!checkpointId) return { ok: false, error: "No stage was selected." };

  const result = await confirmCheckpoint({
    checkpointId,
    actualAt: instant(form, "actualAt") ?? new Date().toISOString(),
    exceptionKind: field(form, "exceptionKind") as CheckpointException | null,
    note: field(form, "note"),
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/shipments/${shipmentId}`);
  revalidatePath("/");

  return { ok: true, error: null };
}

/**
 * Assignment.
 *
 * These two decide who can SEE this shipment, which makes them the most
 * consequential endpoints in the app after the party grant. Both re-establish
 * the session, both bind the shipment id on the server, and neither is the
 * boundary: `shipment_assignments_insert_admin` refuses an operator even if
 * this code were called wrongly.
 */
export async function assignOperator(
  shipmentId: string,
  _prev: AssignmentFormState,
  form: FormData
): Promise<AssignmentFormState> {
  const session = await requireSession();

  if (!canAssignShipments(session.activeRole)) {
    return { ok: false, error: "Only an admin can change who is on a shipment." };
  }

  const result = await assignShipment({
    orgId: session.activeOrg.id,
    shipmentId,
    userId: field(form, "userId") ?? "",
    assignedBy: session.userId,
  });

  if (!result.ok) return result;

  revalidatePath(`/shipments/${shipmentId}`);
  // The person just added now has a shipment on their board, and the person
  // removed no longer does.
  revalidatePath("/");

  return { ok: true, error: null };
}

export async function removeAssignment(
  shipmentId: string,
  _prev: AssignmentFormState,
  form: FormData
): Promise<AssignmentFormState> {
  const session = await requireSession();

  if (!canAssignShipments(session.activeRole)) {
    return { ok: false, error: "Only an admin can change who is on a shipment." };
  }

  const assignmentId = field(form, "assignmentId");
  if (!assignmentId) return { ok: false, error: "No assignment was selected." };

  const result = await endAssignment(assignmentId);
  if (!result.ok) return result;

  revalidatePath(`/shipments/${shipmentId}`);
  revalidatePath("/");

  return { ok: true, error: null };
}

/**
 * Editing a shipment, and moving it through its lifecycle.
 *
 * Under 0008 an operator reaches these only for a shipment they are assigned
 * to — `shipments_update_assigned` is the enforcement, and a `using` failure
 * raises nothing, so the service reports "not yours to change" rather than
 * claiming success on a write that matched no rows.
 */
export async function updateShipmentAction(
  shipmentId: string,
  _prev: ShipmentFormState,
  form: FormData
): Promise<ShipmentFormState> {
  const session = await requireSession();

  // Same contract as the create action: a rejection hands the typing back,
  // because this is the SAME form component and React resets it either way.
  // On an edit the loss is subtler and worse — the boxes come back filled
  // with the ORIGINAL values, so it looks as though the change was saved.
  const failed = (error: string): ShipmentFormState => ({
    ok: false,
    error,
    values: submittedValues(form),
    attempt: (_prev.attempt ?? 0) + 1,
  });

  if (!canEditShipments(session.activeRole)) {
    return failed("Your role cannot change shipments.");
  }

  const result = await updateShipment(shipmentId, readShipment(form));
  if (!result.ok) return failed(result.error ?? "Could not save the shipment.");

  revalidatePath(`/shipments/${shipmentId}`);
  revalidatePath("/");

  return { ok: true, error: null, attempt: (_prev.attempt ?? 0) + 1 };
}

const LIFECYCLE: Record<string, LifecycleEvent> = {
  dispatch: "dispatch",
  deliver: "deliver",
  hold: "hold",
  resume: "resume",
  cancel: "cancel",
};

/**
 * Dispatch, deliver, hold, resume, cancel.
 *
 * These write TIMESTAMPS, not a status — `shipments_sync_status` derives the
 * status from them, and a status written here could disagree with the
 * timestamps. `on_hold` is the exception: nothing derives it, because "this
 * load has stopped" is a human assertion rather than a computation.
 *
 * Cancelling is admin-only. The others are open to whoever may edit the
 * shipment: an operator confirming their own load has left is the core loop.
 */
export async function lifecycleAction(
  shipmentId: string,
  _prev: ShipmentFormState,
  form: FormData
): Promise<ShipmentFormState> {
  const session = await requireSession();

  const requested = field(form, "event") ?? "";
  const event = LIFECYCLE[requested];
  if (!event) return { ok: false, error: "That is not something to do." };

  if (event === "cancel") {
    if (!canManageParties(session.activeRole)) {
      return { ok: false, error: "Only an admin can cancel a shipment." };
    }
  } else if (!canEditShipments(session.activeRole)) {
    return { ok: false, error: "Your role cannot change shipments." };
  }

  // The moment comes from the operator when they give one — they are the
  // witness to when the truck actually left — and from the server otherwise.
  const at = readInstant(form, "at") ?? new Date().toISOString();

  const result = await applyLifecycleEvent(shipmentId, event, at);
  if (!result.ok) return result;

  revalidatePath(`/shipments/${shipmentId}`);
  revalidatePath("/");

  return { ok: true, error: null };
}

/**
 * Sharing a shipment with the customer.
 *
 * One action resolves the short name AND makes the grant. A two-step
 * "search, then pick" would put a tenant-shaped list on screen, and the whole
 * point of `find_organisation_by_slug` is that there is no list: an exact
 * name in, one organisation out, or nothing.
 */
export async function grantPartyAction(
  shipmentId: string,
  _prev: PartyFormState,
  form: FormData
): Promise<PartyFormState> {
  const session = await requireSession();

  if (!canManageParties(session.activeRole)) {
    return { ok: false, error: "Only an admin can share a shipment." };
  }

  const slug = field(form, "slug");
  if (!slug) return { ok: false, error: "Enter the customer's short name." };

  const lookup = await findCounterparty(slug);

  // "Could not look" is not "not there". Reporting the first as the second
  // would send the owner back to their customer to re-check a name that was
  // right all along.
  if (lookup.status === "unavailable") {
    return { ok: false, error: lookup.reason };
  }
  if (lookup.status === "not_found") {
    return {
      ok: false,
      error:
        `No organisation has the short name "${slug}". ` +
        "Ask them for it — it is the name in their own address bar.",
    };
  }

  const result = await grantParty({
    orgId: session.activeOrg.id,
    shipmentId,
    partyOrgId: lookup.organisation.id,
    partyRole: (field(form, "partyRole") ?? "consignee") as PartyRole,
    grantedBy: session.userId,
  });

  if (!result.ok) return result;

  revalidatePath(`/shipments/${shipmentId}`);
  return { ok: true, error: null };
}

export async function revokePartyAction(
  shipmentId: string,
  _prev: PartyFormState,
  form: FormData
): Promise<PartyFormState> {
  const session = await requireSession();

  if (!canManageParties(session.activeRole)) {
    return { ok: false, error: "Only an admin can change who sees a shipment." };
  }

  const partyId = field(form, "partyId");
  if (!partyId) return { ok: false, error: "No grant was selected." };

  const result = await revokeParty({ partyId, revokedBy: session.userId });
  if (!result.ok) return result;

  revalidatePath(`/shipments/${shipmentId}`);
  return { ok: true, error: null };
}

/**
 * Open or close the message channel on one grant.
 *
 * Separate from granting, and off by default, because turning it on is the
 * decision to let another tenant WRITE a row in your database. 0007 made that
 * default deliberately; a grant form that quietly enabled it would undo the
 * reasoning without anybody noticing.
 */
export async function setPartyMessagingAction(
  shipmentId: string,
  _prev: PartyFormState,
  form: FormData
): Promise<PartyFormState> {
  const session = await requireSession();

  if (!canManageParties(session.activeRole)) {
    return { ok: false, error: "Only an admin can change messaging." };
  }

  const partyId = field(form, "partyId");
  if (!partyId) return { ok: false, error: "No grant was selected." };

  const result = await setPartyMessaging(partyId, form.get("enabled") !== "false");
  if (!result.ok) return result;

  revalidatePath(`/shipments/${shipmentId}`);
  return { ok: true, error: null };
}
