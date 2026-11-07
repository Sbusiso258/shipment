"use client";

import { useActionState, useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { GazetteerPlace } from "@/services/checkpoints";
import type { Driver, LocationPoint, Vehicle } from "@/types/domain";

import {
  EMPTY_FORM_STATE,
  type ShipmentFormState,
} from "./shipment-form-state";

/**
 * Recording a shipment.
 *
 * Three rules are enforced by the shape of this form rather than by a
 * validator, because a validator can be argued with:
 *
 *   NO STATUS FIELD. `shipments_sync_status` derives the status from the
 *   dispatch and delivery timestamps. A dropdown here could disagree with the
 *   trigger, and then two parts of the product would tell the customer
 *   different things.
 *
 *   CARGO VALUE STARTS EMPTY AND STAYS EMPTY. Null means NOT DISCLOSED; zero
 *   claims the load is worthless. A default of 0 would quietly assert
 *   something nobody said.
 *
 *   PROMISED DELIVERY IS A DATE, NOT AN INSTANT. It is a commercial promise
 *   made in days — "by Thursday" — and the whole lateness model judges it
 *   against the END of that day in the organisation's timezone. A
 *   datetime-local here would make a shipment late at 00:01.
 */

type Action = (prev: ShipmentFormState, form: FormData) => Promise<ShipmentFormState>;

const SELECT =
  "h-10 w-full rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950";

const MODES = [
  ["road", "Road freight"],
  ["rail", "Rail freight"],
  ["air", "Air freight"],
  ["sea", "Sea freight"],
  ["multimodal", "Multimodal"],
] as const;

const STAGE_KINDS = [
  ["pickup", "Pickup"],
  ["depot_out", "Left depot"],
  ["linehaul", "On the road"],
  ["hub_scan", "Hub scan"],
  ["depot_in", "Arrived at depot"],
  ["out_for_delivery", "Out for delivery"],
  ["delivery", "Delivery"],
  ["pod", "Proof of delivery"],
] as const;

interface StageRow {
  id: number;
  kind: string;
  label: string;
  placeId: string;
  plannedAt: string;
}

function blankStage(id: number): StageRow {
  return { id, kind: "pickup", label: "", placeId: "", plannedAt: "" };
}

/**
 * One fleet field: pick ours, or say it is not ours and type it.
 *
 * NOT a plain dropdown of fleet rows. Subcontracted trucks and hired-in
 * drivers are ordinary in road freight, so a picker that only offered fleet
 * rows would make those loads unrecordable — and the operator would put the
 * registration in the notes, where nothing can group or search it.
 *
 * Only ONE of the two posts. With a fleet row chosen, the id goes up and the
 * service reads the name off that row; with "not ours" chosen, the text goes
 * up and no id does. Posting both would send two versions of one fact and
 * leave the server picking a winner.
 */
function FleetField({
  idName,
  textName,
  label,
  options,
  otherLabel,
  emptyHint,
  defaultId,
  defaultText,
  placeholder,
  code = false,
}: {
  idName: string;
  textName: string;
  label: string;
  options: { id: string; label: string; archived: boolean }[];
  otherLabel: string;
  emptyHint: string;
  defaultId?: string;
  defaultText?: string;
  placeholder?: string;
  code?: boolean;
}) {
  const [chosen, setChosen] = useState(defaultId ?? "");

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`ship-${idName}`}>{label}</Label>
      <select
        id={`ship-${idName}`}
        name={idName}
        value={chosen}
        onChange={(event) => setChosen(event.target.value)}
        className={SELECT}
      >
        <option value="">{otherLabel}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {/* An archived row still shows while it is the one on this load:
                hiding it would silently blank the field on the next save. */}
            {option.label}
            {option.archived ? " (archived)" : ""}
          </option>
        ))}
      </select>

      {chosen === "" ? (
        <>
          <Input
            name={textName}
            defaultValue={defaultText}
            placeholder={placeholder}
            aria-label={`${label} — not from our fleet`}
            className={code ? "font-code" : undefined}
          />
          <p className="text-micro text-ink-400">
            {options.length === 0 ? emptyHint : "Type it if it is not ours."}
          </p>
        </>
      ) : null}
    </div>
  );
}

export interface ShipmentDefaults {
  reference: string;
  direction: string;
  mode: string;
  originLocationId: string;
  destinationLocationId: string;
  carrierName: string;
  driverId: string;
  vehicleId: string;
  vehicleRegistration: string;
  driverName: string;
  goodsDescription: string;
  cargoValue: string;
  weightKg: string;
  plannedDispatchAt: string;
  plannedDeliveryAt: string;
  promisedDeliveryDate: string;
  silenceThresholdDays: string;
  notes: string;
}

function Status({ state, success }: { state: ShipmentFormState; success: string }) {
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
      <div
        role="status"
        className="rounded-control bg-ontime-bg px-3 py-2 text-small text-ontime"
      >
        {success}
        {state.unsavedStages && state.unsavedStages.length > 0 ? (
          <p className="mt-1 text-late">
            These stages did not save: {state.unsavedStages.join(", ")}. Add them
            on the shipment page.
          </p>
        ) : null}
      </div>
    );
  }
  return null;
}

export function ShipmentForm({
  action,
  locations,
  places,
  drivers,
  vehicles,
  defaults,
  withStages = false,
  submitLabel = "Record shipment",
  successMessage = "Saved.",
}: {
  action: Action;
  locations: LocationPoint[];
  places: GazetteerPlace[];
  /** Live rows, plus whichever archived row this load already names. */
  drivers: Driver[];
  vehicles: Vehicle[];
  defaults?: ShipmentDefaults;
  /** Only the create form lays out a route; editing one stage at a time
      belongs to the composer on the shipment page. */
  withStages?: boolean;
  submitLabel?: string;
  successMessage?: string;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);
  const [stages, setStages] = useState<StageRow[]>(() => [blankStage(0)]);
  const [nextId, setNextId] = useState(1);

  function addStage() {
    setStages((rows) => [...rows, blankStage(nextId)]);
    setNextId((id) => id + 1);
  }

  function removeStage(id: number) {
    setStages((rows) => (rows.length === 1 ? rows : rows.filter((r) => r.id !== id)));
  }

  function patchStage(id: number, patch: Partial<StageRow>) {
    setStages((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  return (
    <form action={submit} className="flex flex-col gap-5">
      {/* --- what it is ------------------------------------------------- */}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-small font-medium text-ink-600">
          The shipment
        </legend>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-reference">Reference</Label>
            <Input
              id="ship-reference"
              name="reference"
              required
              defaultValue={defaults?.reference}
              placeholder="N3-0042"
              className="font-code"
            />
            <p className="text-micro text-ink-400">Your number for this load.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-direction">Direction</Label>
            <select
              id="ship-direction"
              name="direction"
              defaultValue={defaults?.direction ?? "outbound"}
              className={SELECT}
            >
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-mode">Method</Label>
            <select
              id="ship-mode"
              name="mode"
              defaultValue={defaults?.mode ?? "road"}
              className={SELECT}
            >
              {MODES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-origin">From</Label>
            <select
              id="ship-origin"
              name="originLocationId"
              required
              defaultValue={defaults?.originLocationId ?? ""}
              className={SELECT}
            >
              <option value="" disabled>
                Choose a place…
              </option>
              {locations.map((place) => (
                <option key={place.locationId} value={place.locationId}>
                  {place.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-destination">To</Label>
            <select
              id="ship-destination"
              name="destinationLocationId"
              required
              defaultValue={defaults?.destinationLocationId ?? ""}
              className={SELECT}
            >
              <option value="" disabled>
                Choose a place…
              </option>
              {locations.map((place) => (
                <option key={place.locationId} value={place.locationId}>
                  {place.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      {/* --- who is moving it -------------------------------------------- */}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-small font-medium text-ink-600">
          Who is moving it
        </legend>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-carrier">Carrier</Label>
            <Input
              id="ship-carrier"
              name="carrierName"
              defaultValue={defaults?.carrierName}
              placeholder="Own fleet"
            />
          </div>
          <FleetField
            idName="vehicleId"
            textName="vehicleRegistration"
            label="Vehicle"
            otherLabel="Not from our fleet"
            emptyHint="No vehicles on the fleet yet — add them under Vehicles."
            placeholder="ND 123-456"
            code
            defaultId={defaults?.vehicleId}
            defaultText={defaults?.vehicleRegistration}
            options={vehicles.map((vehicle) => ({
              id: vehicle.id,
              label: vehicle.registration,
              archived: vehicle.archivedAt !== null,
            }))}
          />
          <FleetField
            idName="driverId"
            textName="driverName"
            label="Driver"
            otherLabel="Not one of our drivers"
            emptyHint="No drivers on the fleet yet — add them under Drivers."
            defaultId={defaults?.driverId}
            defaultText={defaults?.driverName}
            options={drivers.map((driver) => ({
              id: driver.id,
              label: driver.fullName,
              archived: driver.archivedAt !== null,
            }))}
          />
        </div>
      </fieldset>

      {/* --- the load ----------------------------------------------------- */}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-small font-medium text-ink-600">The load</legend>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ship-goods">Goods</Label>
          <Input
            id="ship-goods"
            name="goodsDescription"
            defaultValue={defaults?.goodsDescription}
            placeholder="General merchandise, 12 pallets"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-value">Cargo value (ZAR)</Label>
            <Input
              id="ship-value"
              name="cargoValue"
              type="number"
              min="0"
              step="0.01"
              defaultValue={defaults?.cargoValue}
              placeholder=""
            />
            {/* No default, and the help text says why an empty box is a real
                answer rather than an unfinished one. */}
            <p className="text-micro text-ink-400">
              Leave blank if it is not disclosed. Blank is not zero — it is
              hidden from the shipment rather than shown as worthless.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-weight">Weight (kg)</Label>
            <Input
              id="ship-weight"
              name="weightKg"
              type="number"
              min="0"
              step="0.001"
              defaultValue={defaults?.weightKg}
            />
          </div>
        </div>
      </fieldset>

      {/* --- the promise -------------------------------------------------- */}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-small font-medium text-ink-600">
          Times
        </legend>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-dispatch">Planned dispatch</Label>
            <Input
              id="ship-dispatch"
              name="plannedDispatchAt"
              type="datetime-local"
              defaultValue={defaults?.plannedDispatchAt}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-eta">Expected arrival</Label>
            <Input
              id="ship-eta"
              name="plannedDeliveryAt"
              type="datetime-local"
              defaultValue={defaults?.plannedDeliveryAt}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-promised">Promised by</Label>
            <Input
              id="ship-promised"
              name="promisedDeliveryDate"
              type="date"
              defaultValue={defaults?.promisedDeliveryDate}
            />
            <p className="text-micro text-ink-400">
              A day, not a time. Late at the end of this day, in your timezone.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-silence">Silence threshold (days)</Label>
            <Input
              id="ship-silence"
              name="silenceThresholdDays"
              type="number"
              min="1"
              max="30"
              defaultValue={defaults?.silenceThresholdDays}
            />
            <p className="text-micro text-ink-400">
              Days without a stage before this load is reported as silent.
              Blank uses the organisation default.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-notes">Notes</Label>
            <Input id="ship-notes" name="notes" defaultValue={defaults?.notes} />
          </div>
        </div>
      </fieldset>

      {/* --- the route ---------------------------------------------------- */}
      {withStages ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-small font-medium text-ink-600">
            Planned route
          </legend>
          <p className="-mt-2 text-micro text-ink-400">
            Optional. The stages you expect, in order. Leave a row blank to skip
            it — nothing is invented, and you can add stages later.
          </p>

          <ol className="flex flex-col gap-2">
            {stages.map((stage, index) => (
              <li
                key={stage.id}
                className="grid items-end gap-2 rounded-control bg-canvas/70 p-3 sm:grid-cols-[auto_1fr_1fr_1fr_auto]"
              >
                <span className="font-code text-micro text-ink-400 sm:pb-3">
                  {index + 1}
                </span>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`stage-kind-${stage.id}`} className="text-micro">
                    Stage
                  </Label>
                  <select
                    id={`stage-kind-${stage.id}`}
                    name="stageKind"
                    value={stage.kind}
                    onChange={(e) => patchStage(stage.id, { kind: e.target.value })}
                    className={SELECT}
                  >
                    {STAGE_KINDS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`stage-label-${stage.id}`} className="text-micro">
                    Describe it
                  </Label>
                  <Input
                    id={`stage-label-${stage.id}`}
                    name="stageLabel"
                    value={stage.label}
                    onChange={(e) => patchStage(stage.id, { label: e.target.value })}
                    placeholder="Collected in Johannesburg"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`stage-place-${stage.id}`} className="text-micro">
                    Where
                  </Label>
                  <select
                    id={`stage-place-${stage.id}`}
                    name="stagePlaceId"
                    value={stage.placeId}
                    onChange={(e) => patchStage(stage.id, { placeId: e.target.value })}
                    className={SELECT}
                  >
                    <option value="">Not set</option>
                    {places.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-end gap-2">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor={`stage-at-${stage.id}`} className="text-micro">
                      Planned
                    </Label>
                    <Input
                      id={`stage-at-${stage.id}`}
                      name="stagePlannedAt"
                      type="datetime-local"
                      value={stage.plannedAt}
                      onChange={(e) =>
                        patchStage(stage.id, { plannedAt: e.target.value })
                      }
                    />
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeStage(stage.id)}
                    disabled={stages.length === 1}
                    aria-label={`Remove stage ${index + 1}`}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ol>

          <div>
            <Button type="button" variant="secondary" size="sm" onClick={addStage}>
              <Plus aria-hidden />
              Add a stage
            </Button>
          </div>
        </fieldset>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>

      <Status state={state} success={successMessage} />
    </form>
  );
}
