import type { Driver, Vehicle, VehicleType } from "@/types/domain";

import { fail } from "./fail";
import { supabaseServer } from "./supabase/server";

/**
 * The people and the trucks.
 *
 * Both tables arrived in 0011, replacing two free-text columns on
 * `shipments`. No organisation filter and no role check here: RLS decides
 * what these return and whether the writes land, exactly as everywhere else
 * in `src/services`.
 *
 * ARCHIVED ROWS ARE STILL READ. A driver who has left still appears on the
 * loads they carried, so the pickers exclude them and the lists can show
 * them — `includeArchived` is the caller's choice, not a filter applied here
 * on their behalf.
 */

const DRIVER_COLUMNS =
  "id, org_id, full_name, phone, licence_number, licence_class, licence_expiry, notes, archived_at, created_at";

const VEHICLE_COLUMNS =
  "id, org_id, registration, make, model, vehicle_type, capacity_kg, service_due, notes, archived_at, created_at";

export interface WriteResult {
  ok: boolean;
  error: string | null;
}

export interface DriverInput {
  fullName: string;
  phone: string | null;
  licenceNumber: string | null;
  licenceClass: string | null;
  /** `YYYY-MM-DD`. A licence expires on a day, not at an instant. */
  licenceExpiry: string | null;
  notes: string | null;
}

export interface VehicleInput {
  registration: string;
  make: string | null;
  model: string | null;
  vehicleType: VehicleType;
  capacityKg: number | null;
  /** `YYYY-MM-DD`, same reasoning as a licence expiry. */
  serviceDue: string | null;
  notes: string | null;
}

/** Constraint names are not error messages. Each of these is a real rule. */
function describe(message: string, fallback: string): string {
  if (message.includes("drivers_org_name_idx")) {
    return "There is already a driver with that name. Archive the old one first.";
  }
  if (message.includes("vehicles_org_registration_idx")) {
    return "That registration is already on the fleet, possibly spelled differently.";
  }
  if (message.includes("drivers_full_name_check")) {
    return "Give the driver a name.";
  }
  if (message.includes("vehicles_registration_check")) {
    return "Give the vehicle a registration.";
  }
  if (message.includes("capacity_kg")) {
    return "A capacity has to be greater than zero. Leave it blank if unknown.";
  }
  if (message.includes("shipments_driver_fkey") || message.includes("shipments_vehicle_fkey")) {
    // NO ACTION on the foreign key, so this is what deleting an in-use row
    // looks like. Archiving is the path, and the message says so.
    return "This has carried a load, so it cannot be deleted. Archive it instead.";
  }
  if (message.includes("row-level security")) {
    return "Your role cannot change the fleet.";
  }
  return fallback;
}

interface DriverRow {
  id: string;
  org_id: string;
  full_name: string;
  phone: string | null;
  licence_number: string | null;
  licence_class: string | null;
  licence_expiry: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
}

interface VehicleRow {
  id: string;
  org_id: string;
  registration: string;
  make: string | null;
  model: string | null;
  vehicle_type: VehicleType;
  capacity_kg: string | number | null;
  service_due: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
}

/** Postgres sends `numeric` as a string, to avoid a float rounding it. */
function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapDriver(row: DriverRow): Driver {
  return {
    id: row.id,
    orgId: row.org_id,
    fullName: row.full_name,
    phone: row.phone,
    licenceNumber: row.licence_number,
    licenceClass: row.licence_class,
    licenceExpiry: row.licence_expiry,
    notes: row.notes,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

function mapVehicle(row: VehicleRow): Vehicle {
  return {
    id: row.id,
    orgId: row.org_id,
    registration: row.registration,
    make: row.make,
    model: row.model,
    vehicleType: row.vehicle_type,
    capacityKg: toNumber(row.capacity_kg),
    serviceDue: row.service_due,
    notes: row.notes,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------------ */
/* Reads                                                                      */
/* ------------------------------------------------------------------------ */

export async function listDrivers(includeArchived = false): Promise<Driver[]> {
  const supabase = await supabaseServer();

  let query = supabase
    .from("drivers")
    .select(DRIVER_COLUMNS)
    .order("full_name", { ascending: true });

  if (!includeArchived) query = query.is("archived_at", null);

  const { data, error } = await query;
  if (error) fail("load drivers", error);

  return ((data ?? []) as unknown as DriverRow[]).map(mapDriver);
}

export async function listVehicles(includeArchived = false): Promise<Vehicle[]> {
  const supabase = await supabaseServer();

  let query = supabase
    .from("vehicles")
    .select(VEHICLE_COLUMNS)
    .order("registration", { ascending: true });

  if (!includeArchived) query = query.is("archived_at", null);

  const { data, error } = await query;
  if (error) fail("load vehicles", error);

  return ((data ?? []) as unknown as VehicleRow[]).map(mapVehicle);
}

/* ------------------------------------------------------------------------ */
/* Writes                                                                     */
/* ------------------------------------------------------------------------ */

export async function createDriver(
  input: DriverInput & { orgId: string }
): Promise<WriteResult> {
  const fullName = input.fullName.trim();
  if (!fullName) return { ok: false, error: "Give the driver a name." };

  const supabase = await supabaseServer();
  const { error } = await supabase.from("drivers").insert({
    org_id: input.orgId,
    full_name: fullName,
    phone: input.phone,
    licence_number: input.licenceNumber,
    licence_class: input.licenceClass,
    licence_expiry: input.licenceExpiry,
    notes: input.notes,
  });

  if (error) return { ok: false, error: describe(error.message, "Could not save the driver.") };
  return { ok: true, error: null };
}

export async function createVehicle(
  input: VehicleInput & { orgId: string }
): Promise<WriteResult> {
  const registration = input.registration.trim();
  if (!registration) return { ok: false, error: "Give the vehicle a registration." };

  const supabase = await supabaseServer();
  const { error } = await supabase.from("vehicles").insert({
    org_id: input.orgId,
    registration,
    make: input.make,
    model: input.model,
    vehicle_type: input.vehicleType,
    capacity_kg: input.capacityKg,
    service_due: input.serviceDue,
    notes: input.notes,
  });

  if (error) return { ok: false, error: describe(error.message, "Could not save the vehicle.") };
  return { ok: true, error: null };
}

/**
 * Retire a driver or a vehicle without deleting it.
 *
 * `shipments_driver_fkey` is NO ACTION, so anything that has carried a load
 * cannot be deleted at all. That is the intended path: the loads they carried
 * are the record, and the record does not get edited because somebody left.
 */
export async function setDriverArchived(
  driverId: string,
  archived: boolean
): Promise<WriteResult> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("drivers")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", driverId)
    .select("id");

  if (error) return { ok: false, error: describe(error.message, "Could not change the driver.") };
  // A `using` failure raises nothing — the update simply matches no rows.
  if (!data || data.length === 0) {
    return { ok: false, error: "That driver is not yours to change." };
  }
  return { ok: true, error: null };
}

export async function setVehicleArchived(
  vehicleId: string,
  archived: boolean
): Promise<WriteResult> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("vehicles")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", vehicleId)
    .select("id");

  if (error) return { ok: false, error: describe(error.message, "Could not change the vehicle.") };
  if (!data || data.length === 0) {
    return { ok: false, error: "That vehicle is not yours to change." };
  }
  return { ok: true, error: null };
}
