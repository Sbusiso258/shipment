import type { ShipmentInput } from "@/services/shipments";
import type {
  CheckpointKind,
  ShipmentDirection,
  TransportMode,
} from "@/types/domain";

/**
 * Reading a shipment out of a `FormData`.
 *
 * A plain module, NOT a `"use server"` file: every export from one of those
 * becomes a callable HTTP endpoint, so shared helpers cannot live beside the
 * actions that use them. Both the create and the edit action import from here
 * so the two cannot drift — and drifting is the realistic failure, since the
 * difference would be a field that silently stops saving on one screen.
 */

export function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `datetime-local` gives wall-clock text with no zone. Interpreting it on the
 * server would be wrong — the server runs UTC and the operator does not.
 */
export function instant(form: FormData, name: string): string | null {
  const raw = field(form, name);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * A number, or null — NEVER zero by accident.
 *
 * `Number("")` is 0, and for `cargo_value` that difference is the whole of
 * non-negotiable #9: null means not disclosed, zero claims the load is
 * worthless.
 */
export function numeric(form: FormData, name: string): number | null {
  const raw = field(form, name);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readShipment(form: FormData): ShipmentInput {
  return {
    reference: field(form, "reference") ?? "",
    direction: (field(form, "direction") ?? "outbound") as ShipmentDirection,
    mode: (field(form, "mode") ?? "road") as TransportMode,
    originLocationId: field(form, "originLocationId") ?? "",
    destinationLocationId: field(form, "destinationLocationId") ?? "",
    carrierName: field(form, "carrierName"),
    // The pickers post an id when the load is on our own fleet and nothing
    // when it is not. The service reads the name off the fleet row itself, so
    // the free-text fields below are only ever used for a subcontracted truck
    // or a hired-in driver — and only one of the two can win per field.
    driverId: field(form, "driverId"),
    vehicleId: field(form, "vehicleId"),
    vehicleRegistration: field(form, "vehicleRegistration"),
    driverName: field(form, "driverName"),
    goodsDescription: field(form, "goodsDescription"),
    cargoValue: numeric(form, "cargoValue"),
    weightKg: numeric(form, "weightKg"),
    plannedDispatchAt: instant(form, "plannedDispatchAt"),
    plannedDeliveryAt: instant(form, "plannedDeliveryAt"),
    // A calendar day, passed through untouched. Turning it into an instant is
    // the two-hour lateness error AGENTS.md warns about.
    promisedDeliveryDate: field(form, "promisedDeliveryDate"),
    silenceThresholdDays: numeric(form, "silenceThresholdDays"),
    notes: field(form, "notes"),
  };
}

export interface PlannedStage {
  kind: CheckpointKind;
  label: string;
  saPlaceId: string | null;
  plannedAt: string | null;
}

/**
 * The repeated stage rows, zipped back into records.
 *
 * The form posts four parallel lists rather than indexed names, so the rows
 * line up by position. A row with no description is one the operator left
 * blank and is dropped — the alternative is inventing a label for a stage
 * nobody described.
 */
export function readStages(form: FormData): PlannedStage[] {
  const kinds = form.getAll("stageKind");
  const labels = form.getAll("stageLabel");
  const places = form.getAll("stagePlaceId");
  const times = form.getAll("stagePlannedAt");

  const stages: PlannedStage[] = [];

  for (let i = 0; i < labels.length; i += 1) {
    const label = String(labels[i] ?? "").trim();
    if (!label) continue;

    const raw = String(times[i] ?? "").trim();
    const parsed = raw ? new Date(raw) : null;

    stages.push({
      kind: (String(kinds[i] ?? "linehaul") || "linehaul") as CheckpointKind,
      label,
      saPlaceId: String(places[i] ?? "") || null,
      plannedAt:
        parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    });
  }

  return stages;
}
