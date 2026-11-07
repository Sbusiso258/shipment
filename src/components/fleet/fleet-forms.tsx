"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { VehicleType } from "@/types/domain";

import { EMPTY_FORM_STATE, type FleetFormState } from "./fleet-form-state";

/**
 * Adding a driver or a vehicle.
 *
 * Two things here are the same decision made twice, and both are worth
 * naming:
 *
 *   A LICENCE EXPIRY AND A SERVICE DATE ARE `date` INPUTS, not
 *   `datetime-local`. Both are days a human is held to, like
 *   `promised_delivery_date` — and like it, judging them against an instant
 *   would put the rollover at 02:00 local.
 *
 *   CAPACITY STARTS EMPTY AND STAYS EMPTY. Blank means not recorded; zero
 *   would say the vehicle carries nothing.
 */

type Action = (prev: FleetFormState, form: FormData) => Promise<FleetFormState>;

const SELECT =
  "h-10 w-full rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950";

const VEHICLE_TYPES: [VehicleType, string][] = [
  ["rigid", "Rigid truck"],
  ["tractor", "Tractor unit"],
  ["trailer", "Trailer"],
  ["bakkie", "Bakkie"],
  ["van", "Van"],
  ["other", "Other"],
];

function Status({ state, success }: { state: FleetFormState; success: string }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="rounded-control bg-exception-bg px-3 py-2 text-small text-exception"
      >
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p
        role="status"
        className="rounded-control bg-ontime-bg px-3 py-2 text-small text-ontime"
      >
        {success}
      </p>
    );
  }
  return null;
}

export function DriverForm({ action }: { action: Action }) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="driver-name">Full name</Label>
          <Input
            id="driver-name"
            name="fullName"
            required
            autoComplete="off"
            placeholder="Thabo Nkosi"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="driver-phone">Phone</Label>
          <Input
            id="driver-phone"
            name="phone"
            type="tel"
            autoComplete="off"
            placeholder="+27 82 000 0000"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="driver-licence">Licence number</Label>
          <Input id="driver-licence" name="licenceNumber" autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="driver-class">Class</Label>
          <Input id="driver-class" name="licenceClass" placeholder="EC" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="driver-expiry">Licence expires</Label>
          <Input id="driver-expiry" name="licenceExpiry" type="date" />
          <p className="text-micro text-ink-400">A day, not a time.</p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="driver-notes">Notes</Label>
        <Input id="driver-notes" name="notes" />
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add driver"}
        </Button>
      </div>

      <Status state={state} success="Saved." />
    </form>
  );
}

export function VehicleForm({ action }: { action: Action }) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vehicle-reg">Registration</Label>
          <Input
            id="vehicle-reg"
            name="registration"
            required
            autoComplete="off"
            placeholder="ND 123-456"
            className="font-code"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vehicle-type">Type</Label>
          <select
            id="vehicle-type"
            name="vehicleType"
            defaultValue="rigid"
            className={SELECT}
          >
            {VEHICLE_TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vehicle-capacity">Capacity (kg)</Label>
          <Input
            id="vehicle-capacity"
            name="capacityKg"
            type="number"
            min="0"
            step="0.001"
          />
          <p className="text-micro text-ink-400">
            Leave blank if it is not recorded.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vehicle-make">Make</Label>
          <Input id="vehicle-make" name="make" placeholder="Isuzu" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vehicle-model">Model</Label>
          <Input id="vehicle-model" name="model" placeholder="FTR 850" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vehicle-service">Service due</Label>
          <Input id="vehicle-service" name="serviceDue" type="date" />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="vehicle-notes">Notes</Label>
        <Input id="vehicle-notes" name="notes" />
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add vehicle"}
        </Button>
      </div>

      <Status state={state} success="Saved." />
    </form>
  );
}

/**
 * Retire a driver or a vehicle.
 *
 * Not a delete. `shipments_driver_fkey` is NO ACTION, so anything that has
 * carried a load cannot be deleted at all — the loads it carried are the
 * record, and the record does not change because somebody left.
 */
export function ArchiveFleetButton({
  name,
  id,
  archived,
  action,
}: {
  /** The form field name — `driverId` or `vehicleId`. */
  name: string;
  id: string;
  archived: boolean;
  action: Action;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={submit} className="flex items-center gap-2">
      <input type="hidden" name={name} value={id} />
      <input type="hidden" name="archived" value={archived ? "false" : "true"} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Saving…" : archived ? "Restore" : "Retire"}
      </Button>
      {state.error ? (
        <span role="alert" className="text-micro text-exception">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
