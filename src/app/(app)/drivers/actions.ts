"use server";

import { revalidatePath } from "next/cache";

import { canManageLocations } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { createDriver, setDriverArchived } from "@/services/fleet";

/**
 * The people behind the wheel.
 *
 * Gated on `canManageLocations` — admin and operator. The same people who
 * name a depot name a driver; both are the organisation's own record of how
 * it runs, and neither is a shipment.
 *
 * Each action re-establishes who is asking. A server action is a public HTTP
 * endpoint, so the screen's role check protects the screen and not this; RLS
 * refuses the write regardless, and the check here is for the MESSAGE.
 */

export type { FleetFormState } from "@/components/fleet/fleet-form-state";

import type { FleetFormState } from "@/components/fleet/fleet-form-state";

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function createDriverAction(
  _prev: FleetFormState,
  form: FormData
): Promise<FleetFormState> {
  const session = await requireSession();

  if (!canManageLocations(session.activeRole)) {
    return { ok: false, error: "Your role cannot add drivers." };
  }

  const result = await createDriver({
    orgId: session.activeOrg.id,
    fullName: field(form, "fullName") ?? "",
    phone: field(form, "phone"),
    licenceNumber: field(form, "licenceNumber"),
    licenceClass: field(form, "licenceClass"),
    // A date input gives `YYYY-MM-DD`, which is exactly what the column
    // wants. Turning it into an instant is the two-hour error AGENTS warns
    // about, so it is passed through untouched.
    licenceExpiry: field(form, "licenceExpiry"),
    notes: field(form, "notes"),
  });

  if (!result.ok) return result;

  revalidatePath("/drivers");
  return { ok: true, error: null };
}

export async function archiveDriverAction(
  _prev: FleetFormState,
  form: FormData
): Promise<FleetFormState> {
  const session = await requireSession();

  if (!canManageLocations(session.activeRole)) {
    return { ok: false, error: "Your role cannot change drivers." };
  }

  const driverId = field(form, "driverId");
  if (!driverId) return { ok: false, error: "No driver was selected." };

  const result = await setDriverArchived(driverId, form.get("archived") !== "false");
  if (!result.ok) return result;

  revalidatePath("/drivers");
  // A retired driver leaves the picker on the shipment form.
  revalidatePath("/shipments/new");
  return { ok: true, error: null };
}
