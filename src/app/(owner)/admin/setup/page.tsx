import type { Metadata } from "next";
import Link from "next/link";

import {
  ClearOrganisationDataForm,
  RemoveDemoDataForm,
  SetUpOrganisationForm,
} from "@/components/admin/setup-forms";
import { requireActor } from "@/services/bootstrap";
import { listOrganisations, DEMO_SLUG } from "@/services/provisioning";
import { countClearableData } from "@/services/reset";

import {
  clearOrganisationDataAction,
  removeDemoDataAction,
  setUpOrganisationAction,
} from "../actions";

export const metadata: Metadata = { title: "Set up" };

/**
 * Going live: one real organisation, and the demo data gone.
 *
 * `requireActor`, not `requireSession`. The owner has no membership until the
 * first step on this page succeeds, and `requireSession` would send them to
 * /no-access before they could take it.
 */
export default async function SetupPage() {
  const actor = await requireActor();
  const organisations = await listOrganisations();

  const demo = organisations.find((org) => org.slug === DEMO_SLUG);

  // Only meaningful once the owner is in an organisation; before that there
  // is nothing of theirs to count.
  const clearable =
    actor.memberships.length > 0
      ? await countClearableData()
      : { shipments: 0, announcements: 0 };
  const active = actor.memberships[0]?.organisation ?? null;
  const real = organisations.filter((org) => org.slug !== DEMO_SLUG);
  const inAnOrg = actor.memberships.length > 0;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6">
      <header>
        <Link href="/admin" className="text-small text-ink-600 hover:text-ink-950">
          ← Organisations
        </Link>
        <h1 className="mt-2 text-title font-semibold text-ink-950">Go live</h1>
        <p className="mt-1 text-ink-600">
          Two steps, in this order: create the business that will actually
          record shipments, then clear the demo rows if your project still
          carries them.
        </p>
      </header>

      {/* ---------------------------------------------------------------- */}
      <section className="rounded-panel border border-ink-200 bg-paper p-4 shadow-panel">
        <h2 className="text-lead font-medium text-ink-950">
          1. Your organisation
        </h2>

        {real.length > 0 ? (
          <div className="mt-3 rounded-control bg-ontime-bg px-3 py-2 text-small text-ontime">
            {real.length === 1 ? "Already created: " : "Already created: "}
            {real.map((org) => org.name).join(", ")}.
            {inAnOrg ? " You are a member." : " You are NOT a member of it yet."}
          </div>
        ) : null}

        {!inAnOrg || real.length === 0 ? (
          <div className="mt-3">
            <SetUpOrganisationForm action={setUpOrganisationAction} />
          </div>
        ) : (
          <p className="mt-2 text-small text-ink-600">
            Nothing more to do here.{" "}
            <Link href="/" className="text-marine-200 hover:underline">
              Open the board
            </Link>
            .
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="rounded-panel border border-ink-200 bg-paper p-4 shadow-panel">
        <h2 className="text-lead font-medium text-ink-950">2. The demo data</h2>

        {!demo ? (
          <p className="mt-2 text-small text-ink-600">
            There is no demo organisation. Nothing to remove, and nothing can
            create one — the seed that made it has been deleted.
          </p>
        ) : !inAnOrg && real.length === 0 ? (
          // Removing it first would take away the only organisation the owner
          // belongs to, and /no-access is a poor place to discover that.
          <p className="mt-2 rounded-control bg-late-bg px-3 py-2 text-small text-late">
            Create your organisation first. Removing the demo data while it is
            the only one you belong to would lock you out of the board.
          </p>
        ) : (
          <div className="mt-3">
            <RemoveDemoDataForm action={removeDemoDataAction} slug={DEMO_SLUG} />
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Needs no migration: an admin has been able to delete their own
          shipments since 0004 and retract their own notices since 0007. */}
      {active ? (
        <section className="rounded-panel border border-ink-200 bg-paper p-4 shadow-panel">
          <h2 className="text-lead font-medium text-ink-950">
            3. Start from empty
          </h2>
          <p className="mb-3 mt-1 text-small text-ink-600">
            Clears the shipments and notices out of {active.name} so you can
            enter real ones. Keeps the organisation, its places and its people.
          </p>
          <ClearOrganisationDataForm
            action={clearOrganisationDataAction}
            organisationName={active.name}
            shipments={clearable.shipments}
            announcements={clearable.announcements}
          />
        </section>
      ) : null}
    </main>
  );
}
