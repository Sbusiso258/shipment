"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

import {
  EMPTY_FORM_STATE,
  type SettingsFormState,
} from "./settings-form-state";

/**
 * The organisation's own details.
 *
 * THE TIMEZONE IS NOT COSMETIC. Every "late" judgement in the product is made
 * against the END OF THE PROMISED DAY in this zone. Get it wrong and the
 * board starts shouting at ops every afternoon, which is how a board stops
 * being read.
 *
 * THE SHORT NAME IS SHOWN BUT NOT EDITABLE. No column grant permits changing
 * it, by design — it is what customers type to be given sight of a shipment.
 */

type Action = (prev: SettingsFormState, form: FormData) => Promise<SettingsFormState>;

const ZONES = [
  ["Africa/Johannesburg", "South Africa (SAST)"],
  ["Africa/Maseru", "Lesotho"],
  ["Africa/Mbabane", "Eswatini"],
  ["Africa/Gaborone", "Botswana"],
  ["Africa/Windhoek", "Namibia"],
  ["Africa/Harare", "Zimbabwe"],
  ["Africa/Maputo", "Mozambique"],
] as const;

export interface OrganisationDefaults {
  name: string;
  slug: string;
  timezone: string;
  contactEmail: string | null;
  registrationNumber: string | null;
  defaultSilenceThresholdDays: number;
}

export function SettingsForm({
  action,
  defaults,
}: {
  action: Action;
  defaults: OrganisationDefaults;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={submit} className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-name">Business name</Label>
          <Input
            id="org-name"
            name="name"
            required
            defaultValue={defaults.name}
            autoComplete="organization"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-slug">Short name</Label>
          <Input
            id="org-slug"
            value={defaults.slug}
            readOnly
            disabled
            className="font-code"
          />
          <p className="text-micro text-ink-400">
            Fixed at creation. This is what a customer types to be given sight
            of a shipment, so it cannot be changed from here by anybody.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-timezone">Timezone</Label>
          <select
            id="org-timezone"
            name="timezone"
            defaultValue={defaults.timezone}
            className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
          >
            {ZONES.map(([zone, label]) => (
              <option key={zone} value={zone}>
                {label}
              </option>
            ))}
          </select>
          <p className="text-micro text-ink-400">
            A delivery promised Thursday is late at the end of Thursday here.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-silence">Silence threshold (days)</Label>
          <Input
            id="org-silence"
            name="silenceThresholdDays"
            type="number"
            min="1"
            max="30"
            defaultValue={defaults.defaultSilenceThresholdDays}
          />
          <p className="text-micro text-ink-400">
            Days without a confirmed stage before a load is reported as silent.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-email">Contact email</Label>
          <Input
            id="org-email"
            name="contactEmail"
            type="email"
            defaultValue={defaults.contactEmail ?? ""}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-registration">Registration number</Label>
          <Input
            id="org-registration"
            name="registrationNumber"
            defaultValue={defaults.registrationNumber ?? ""}
          />
        </div>
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </div>

      {state.error ? (
        <p
          role="alert"
          className="rounded-control bg-exception-bg px-3 py-2 text-small text-exception"
        >
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p
          role="status"
          className="rounded-control bg-ontime-bg px-3 py-2 text-small text-ontime"
        >
          Saved.
        </p>
      ) : null}
    </form>
  );
}
