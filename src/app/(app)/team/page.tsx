import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  InviteForm,
  MemberRow,
  RevokeInvitationButton,
} from "@/components/team/team-controls";
import { canInvite } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { listInvitations, listMembers } from "@/services/provisioning";

import {
  changeRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
} from "./actions";

export const metadata: Metadata = { title: "Team" };

/**
 * The people in this organisation, and what each of them may do.
 *
 * The same screens exist under /admin for the platform owner, by organisation.
 * This one is for an admin managing their OWN team, which is where the work
 * actually happens — the owner should not be in the path of a customer hiring
 * a driver.
 */
export default async function TeamPage() {
  const session = await requireSession();

  // notFound(), not a redirect: a redirect confirms the route exists.
  if (!canInvite(session.activeRole)) notFound();

  const [members, invitations] = await Promise.all([
    listMembers(session.activeOrg.id),
    listInvitations(session.activeOrg.id),
  ]);

  const pending = invitations.filter(
    (invitation) => invitation.acceptedAt === null && invitation.revokedAt === null
  );

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold text-ink-950">Team</h1>
          <p className="mt-1 text-ink-600">
            Who works at {session.activeOrg.name}, and what each of them may do.
          </p>
        </div>
        <Link href="/" className="text-small text-ink-600 hover:text-ink-950">
          ← Board
        </Link>
      </header>

      <section className="rounded-panel border border-ink-200 bg-paper-raised shadow-panel">
        <header className="border-b border-ink-200 px-panel py-3">
          <h2 className="text-lead font-medium text-ink-950">
            {members.length} {members.length === 1 ? "person" : "people"}
          </h2>
        </header>

        <ul>
          {members.map((member) => (
            <MemberRow
              key={member.userId}
              userId={member.userId}
              name={member.fullName}
              email={member.email}
              role={member.role}
              isSelf={member.userId === session.userId}
              changeAction={changeRoleAction}
              removeAction={removeMemberAction}
            />
          ))}
        </ul>
      </section>

      <section className="rounded-panel border border-ink-200 bg-paper-raised p-panel shadow-panel">
        <h2 className="text-lead font-medium text-ink-950">Invite somebody</h2>
        <div className="mt-3">
          <InviteForm action={inviteMemberAction} />
        </div>
      </section>

      {pending.length > 0 ? (
        <section className="rounded-panel border border-ink-200 bg-paper-raised shadow-panel">
          <header className="border-b border-ink-200 px-panel py-3">
            <h2 className="text-lead font-medium text-ink-950">
              {pending.length} waiting to be claimed
            </h2>
          </header>

          <ul>
            {pending.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-panel py-3 last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="block truncate text-body text-ink-950">
                    {invitation.email}
                  </span>
                  <span className="block text-micro text-ink-400">
                    {invitation.role}
                  </span>
                </span>

                <RevokeInvitationButton
                  invitationId={invitation.id}
                  action={revokeInvitationAction}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
