"use server";

import { revalidatePath } from "next/cache";

import { canManageLocations } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { createVehicle, setVehicleArchived } from "@/services/fleet";
import type { VehicleType } from "@/types/domain";

/**
 * The fleet.
 *
 * Gated on `canManageLocations` — admin and operator, the same people who
 * name a depot. Each action re-establishes who is asking: a server action is
 * a public HTTP endpoint, so the screen's role check protects the screen and
 * not this. RLS refuses the write regardless.
 */

export type { FleetFormState } from "@/components/fleet/fleet-form-state";

import type { FleetFormState } from "@/components/fleet/fleet-form-state";

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A number, or null — NEVER zero by accident.
 *
 * `Number("")` is 0, and a capacity of zero is a vehicle that cannot carry
 * anything. Blank means "not recorded", which is a different claim.
 */
function numeric(form: FormData, name: string): number | null {
  const raw = field(form, name);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function createVehicleAction(
  _prev: FleetFormState,
  form: FormData
): Promise<FleetFormState> {
  const session = await requireSession();

  if (!canManageLocations(session.activeRole)) {
    return { ok: false, error: "Your role cannot add vehicles." };
  }

  const result = await createVehicle({
    orgId: session.activeOrg.id,
    registration: field(form, "registration") ?? "",
    make: field(form, "make"),
    model: field(form, "model"),
    vehicleType: (field(form, "vehicleType") ?? "other") as VehicleType,
    capacityKg: numeric(form, "capacityKg"),
    // A date input gives `YYYY-MM-DD`, which is what the column wants.
    serviceDue: field(form, "serviceDue"),
    notes: field(form, "notes"),
  });

  if (!result.ok) return result;

  revalidatePath("/vehicles");
  return { ok: true, error: null };
}

export async function archiveVehicleAction(
  _prev: FleetFormState,
  form: FormData
): Promise<FleetFormState> {
  const session = await requireSession();

  if (!canManageLocations(session.activeRole)) {
    return { ok: false, error: "Your role cannot change vehicles." };
  }

  const vehicleId = field(form, "vehicleId");
  if (!vehicleId) return { ok: false, error: "No vehicle was selected." };

  const result = await setVehicleArchived(vehicleId, form.get("archived") !== "false");
  if (!result.ok) return result;

  revalidatePath("/vehicles");
  // A retired vehicle leaves the picker on the shipment form.
  revalidatePath("/shipments/new");
  return { ok: true, error: null };
}
