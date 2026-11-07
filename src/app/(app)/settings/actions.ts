"use server";

import { revalidatePath } from "next/cache";

import { canInvite } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { updateOrganisation } from "@/services/provisioning";

/**
 * The organisation's own details.
 *
 * NO MIGRATION WAS NEEDED FOR ANY OF THIS. `grant update (name,
 * registration_number, contact_email, timezone,
 * default_silence_threshold_days)` has been on `organisations` since 0001 —
 * column privileges, not RLS, are what decide which fields an admin may
 * touch, because RLS filters rows and cannot say "this column only".
 *
 * `slug` is deliberately absent from that grant. An organisation's short name
 * is what customers type to be given sight of a shipment, so it is fixed at
 * creation and cannot be changed here by anybody.
 */

export type { SettingsFormState } from "@/components/settings/settings-form-state";

import type { SettingsFormState } from "@/components/settings/settings-form-state";

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function updateOrganisationAction(
  _prev: SettingsFormState,
  form: FormData
): Promise<SettingsFormState> {
  const session = await requireSession();

  if (!canInvite(session.activeRole)) {
    return { ok: false, error: "Only an admin can change these settings." };
  }

  const threshold = field(form, "silenceThresholdDays");
  const parsed = threshold === null ? null : Number(threshold);

  const result = await updateOrganisation({
    orgId: session.activeOrg.id,
    name: field(form, "name") ?? "",
    timezone: field(form, "timezone") ?? session.activeOrg.timezone,
    contactEmail: field(form, "contactEmail"),
    registrationNumber: field(form, "registrationNumber"),
    defaultSilenceThresholdDays:
      parsed !== null && Number.isFinite(parsed) ? parsed : null,
  });

  if (!result.ok) return result;

  // The name is in the shell, the timezone decides every date on the board,
  // and the threshold decides which shipments are called silent.
  revalidatePath("/", "layout");
  return { ok: true, error: null };
}
