"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

import type { AdminFormState } from "./admin-forms";

/**
 * The two controls that turn a seeded platform into somebody's business.
 *
 * They are deliberately NOT one form. Creating the organisation is additive
 * and reversible; removing the demo data cascades across every shipment,
 * checkpoint, location and task beneath it. Putting a destructive step inside
 * a creative one is how it happens to people who only meant to do the first
 * half.
 */

const EMPTY: AdminFormState = { ok: false, error: null };

type Action = (prev: AdminFormState, form: FormData) => Promise<AdminFormState>;

/**
 * The zones a South African operator plausibly runs in. Cross-border is
 * modelled for rather than built, so the neighbours are here and the list is
 * short — an IANA database in a dropdown is not a choice, it is a search
 * problem.
 */
const ZONES = [
  ["Africa/Johannesburg", "South Africa (SAST)"],
  ["Africa/Maseru", "Lesotho"],
  ["Africa/Mbabane", "Eswatini"],
  ["Africa/Gaborone", "Botswana"],
  ["Africa/Windhoek", "Namibia"],
  ["Africa/Harare", "Zimbabwe"],
  ["Africa/Maputo", "Mozambique"],
] as const;

function Status({ state, success }: { state: AdminFormState; success: string }) {
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

export function SetUpOrganisationForm({ action }: { action: Action }) {
  const [state, submit, pending] = useActionState(action, EMPTY);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="setup-name">Business name</Label>
          <Input
            id="setup-name"
            name="name"
            required
            autoComplete="organization"
            placeholder="Mahlangu Freight"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="setup-slug">Short name</Label>
          <Input id="setup-slug" name="slug" placeholder="mahlangu-freight" />
          <p className="text-micro text-ink-400">
            Used in URLs, and by customers when you share a shipment with them.
            Left blank, it is taken from the name.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="setup-timezone">Timezone</Label>
        <select
          id="setup-timezone"
          name="timezone"
          defaultValue="Africa/Johannesburg"
          className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
        >
          {ZONES.map(([zone, label]) => (
            <option key={zone} value={zone}>
              {label}
            </option>
          ))}
        </select>
        {/* Not cosmetic. A delivery promised "Thursday" is late at the end of
            Thursday HERE, and this is the zone that decides where that is. */}
        <p className="text-micro text-ink-400">
          Lateness is judged against the end of the promised day in this zone.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Setting up…" : "Create and add me as admin"}
        </Button>
        <span className="text-micro text-ink-400">
          You become its admin immediately — no invitation to claim.
        </span>
      </div>

      <Status
        state={state}
        success="Done. Your organisation is ready and you are its admin."
      />
    </form>
  );
}

export function RemoveDemoDataForm({
  action,
  slug,
}: {
  action: Action;
  slug: string;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY);
  const [typed, setTyped] = useState("");

  const armed = typed === slug;

  return (
    <form action={submit} className="flex flex-col gap-3">
      <p className="text-small text-ink-800">
        This deletes the demo organisation and everything beneath it — its
        shipments, their checkpoints, its locations, tasks and notices. There is
        no undo short of a database restore.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="confirm-slug">
            Type <span className="font-code">{slug}</span> to confirm
          </Label>
          <Input
            id="confirm-slug"
            name="confirm"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-code"
          />
        </div>

        {/* Disabled until it matches, and the server checks it again — the
            button is a courtesy, not the control. */}
        <Button type="submit" variant="danger" disabled={pending || !armed}>
          {pending ? "Removing…" : "Remove demo data"}
        </Button>
      </div>

      <Status state={state} success="The demo data is gone." />
    </form>
  );
}

/**
 * Empty the organisation, keeping the organisation.
 *
 * Separate from the demo-removal control because it answers a different
 * question. That one deletes a whole tenant and needs migration 0010. This
 * one clears the loads out of the tenant you are keeping, and works against
 * the schema every project already has.
 *
 * The confirmation is the organisation's own NAME rather than a fixed word.
 * "DELETE" can be typed on autopilot; the name of the business whose
 * shipments are about to go cannot.
 */
export function ClearOrganisationDataForm({
  action,
  organisationName,
  shipments,
  announcements,
}: {
  action: Action;
  organisationName: string;
  shipments: number;
  announcements: number;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY);
  const [typed, setTyped] = useState("");

  const armed = typed === organisationName;
  const nothingToDo = shipments === 0 && announcements === 0;

  if (nothingToDo) {
    return (
      <p className="text-small text-ink-600">
        {organisationName} has no shipments and no notices. The board and the
        Live Feed are already empty.
      </p>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <p className="text-small text-ink-800">
        This removes{" "}
        <strong className="font-medium">
          {shipments} {shipments === 1 ? "shipment" : "shipments"}
        </strong>{" "}
        from {organisationName}, with every stage, message and party grant that
        hangs off them, and retracts{" "}
        <strong className="font-medium">
          {announcements} {announcements === 1 ? "notice" : "notices"}
        </strong>
        . The board and the Live Feed end up empty.
      </p>
      <p className="text-small text-ink-600">
        Your places, your team and the organisation itself are kept. There is
        no undo short of a database restore.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="confirm-org">
            Type <span className="font-medium">{organisationName}</span> to confirm
          </Label>
          <Input
            id="confirm-org"
            name="confirm"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Disabled until it matches, and the server checks it again — the
            button is a courtesy, not the control. */}
        <Button type="submit" variant="danger" disabled={pending || !armed}>
          {pending ? "Clearing…" : "Clear the data"}
        </Button>
      </div>

      <Status state={state} success="Cleared. The board and the feed are empty." />
    </form>
  );
}
