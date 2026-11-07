import type { Metadata } from "next";
import Link from "next/link";

import { CreateOrganisationForm } from "@/components/admin/admin-forms";
import { Button } from "@/components/ui/button";
import { listOrganisations } from "@/services/provisioning";

import { createOrganisationAction } from "./actions";

export const metadata: Metadata = { title: "Organisations" };

export default async function AdminPage() {
  const organisations = await listOrganisations();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold text-ink-950">Organisations</h1>
          <p className="mt-1 text-ink-600">
            Every organisation on the platform. Access is granted here, not by
            anyone signing up.
          </p>
        </div>

        <Button asChild variant="secondary">
          <Link href="/admin/setup">Go live</Link>
        </Button>
      </header>

      <section className="rounded-panel border border-ink-200 bg-paper shadow-panel">
        <header className="border-b border-ink-200 px-4 py-3">
          <h2 className="text-lead font-medium text-ink-950">
            {organisations.length}{" "}
            {organisations.length === 1 ? "organisation" : "organisations"}
          </h2>
        </header>

        {organisations.length === 0 ? (
          <p className="px-4 py-10 text-center text-ink-600">
            None yet. Create the first one below.
          </p>
        ) : (
          <ol>
            {organisations.map((org) => (
              <li key={org.id}>
                <Link
                  href={`/admin/organisations/${org.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-3 hover:bg-ink-100"
                >
                  <span className="min-w-0">
                    <span className="block text-body font-medium text-ink-950">
                      {org.name}
                    </span>
                    <span className="font-code text-micro text-ink-400">
                      {org.slug} · {org.timezone}
                    </span>
                  </span>

                  <span className="flex items-center gap-2 text-small">
                    {org.status !== "active" ? (
                      <span className="rounded-control bg-late-bg px-2 py-0.5 text-late">
                        {org.status}
                      </span>
                    ) : null}
                    <span className="rounded-control bg-ink-100 px-2 py-0.5 text-ink-600">
                      {org.isSubscriber ? "Subscriber" : "Counterparty"}
                    </span>
                    <span className="text-ink-600">
                      {org.memberCount}{" "}
                      {org.memberCount === 1 ? "member" : "members"}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="rounded-panel border border-ink-200 bg-paper p-4 shadow-panel">
        <h2 className="text-lead font-medium text-ink-950">New organisation</h2>
        <p className="mt-1 mb-3 text-small text-ink-600">
          A subscriber records its own shipments. A counterparty only ever views
          shipments shared with it.
        </p>
        <CreateOrganisationForm action={createOrganisationAction} />
      </section>
    </main>
  );
}
