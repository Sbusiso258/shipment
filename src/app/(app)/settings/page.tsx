import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SettingsForm } from "@/components/settings/settings-form";
import { canInvite } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { loadOrganisationDetails } from "@/services/provisioning";

import { updateOrganisationAction } from "./actions";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireSession();

  // notFound(), not a redirect: a redirect confirms the route exists.
  if (!canInvite(session.activeRole)) notFound();

  const details = await loadOrganisationDetails(session.activeOrg.id);
  if (!details) notFound();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-6">
      <header>
        <h1 className="text-title font-semibold text-ink-950">Settings</h1>
        <p className="mt-1 text-ink-600">
          How {details.name} is described, and the two values every judgement
          on the board is made against.
        </p>
      </header>

      <section className="rounded-panel border border-ink-200 bg-paper-raised p-panel shadow-panel">
        <SettingsForm action={updateOrganisationAction} defaults={details} />
      </section>
    </main>
  );
}
