import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { InviteForm, RevokeButton } from "@/components/admin/admin-forms";
import {
  listInvitations,
  listMembers,
  listOrganisations,
} from "@/services/provisioning";

import { inviteMemberAction, revokeInvitationAction } from "../../actions";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const org = (await listOrganisations()).find((o) => o.id === id);
  return { title: org?.name ?? "Organisation" };
}

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

export default async function OrganisationPage({ params }: Params) {
  const { id } = await params;

  // RLS returns nothing rather than refusing, so an organisation the caller
  // may not see is indistinguishable from one that does not exist.
  const org = (await listOrganisations()).find((o) => o.id === id);
  if (!org) notFound();

  const [members, invitations] = await Promise.all([
    listMembers(id),
    listInvitations(id),
  ]);

  const pending = invitations.filter(
    (i) => i.acceptedAt === null && i.revokedAt === null
  );
  const history = invitations.filter(
    (i) => i.acceptedAt !== null || i.revokedAt !== null
  );

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6">
      <div>
        <Link href="/admin" className="text-small text-ink-600 hover:text-ink-950">
          ← All organisations
        </Link>
        <h1 className="mt-2 text-title font-semibold text-ink-950">{org.name}</h1>
        <p className="font-code text-micro text-ink-400">
          {org.slug} · {org.timezone} ·{" "}
          {org.isSubscriber ? "subscriber" : "counterparty"}
        </p>
      </div>

      <section className="rounded-panel border border-ink-200 bg-paper shadow-panel">
        <header className="border-b border-ink-200 px-4 py-3">
          <h2 className="text-lead font-medium text-ink-950">Members</h2>
        </header>

        {members.length === 0 ? (
          <p className="px-4 py-8 text-center text-ink-600">
            Nobody yet. Invite someone below.
          </p>
        ) : (
          <ul>
            {members.map((member) => (
              <li
                key={member.userId}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block text-body text-ink-950">
                    {member.fullName ?? member.email}
                  </span>
                  {member.fullName ? (
                    <span className="font-code text-micro text-ink-400">
                      {member.email}
                    </span>
                  ) : null}
                </span>
                <span className="rounded-control bg-ink-100 px-2 py-0.5 text-small text-ink-600">
                  {ROLE_LABEL[member.role] ?? member.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-panel border border-ink-200 bg-paper p-4 shadow-panel">
        <h2 className="text-lead font-medium text-ink-950">Invite someone</h2>

        {/* The manual step is the price of having no service-role key, and it
            is worth stating rather than letting it look like a bug. */}
        <p className="mt-1 mb-3 text-small text-ink-600">
          Creating an invitation here is the first half. The second is adding
          the user in the Supabase dashboard under{" "}
          <strong>Authentication → Users</strong>; a database trigger turns the
          invitation into a membership when they first sign in. There is no
          public sign-up, deliberately — and no service-role key in this
          project to create users with.
        </p>

        <InviteForm action={inviteMemberAction.bind(null, id)} />
      </section>

      {pending.length > 0 ? (
        <section className="rounded-panel border border-ink-200 bg-paper shadow-panel">
          <header className="border-b border-ink-200 px-4 py-3">
            <h2 className="text-lead font-medium text-ink-950">
              Waiting to be accepted
            </h2>
          </header>
          <ul>
            {pending.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3"
              >
                <span className="font-code text-small text-ink-950">
                  {invitation.email}
                  <span className="ml-2 text-ink-400">
                    {ROLE_LABEL[invitation.role] ?? invitation.role}
                  </span>
                </span>
                <RevokeButton
                  invitationId={invitation.id}
                  action={revokeInvitationAction.bind(null, id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section>
          <h2 className="mb-2 text-small font-medium text-ink-600">
            Earlier invitations
          </h2>
          {/* Revoked, not deleted: that somebody had access and lost it is
              part of the access record. */}
          <ul className="flex flex-col gap-1">
            {history.map((invitation) => (
              <li key={invitation.id} className="font-code text-micro text-ink-400">
                {invitation.email} —{" "}
                {invitation.revokedAt ? "revoked" : "accepted"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
