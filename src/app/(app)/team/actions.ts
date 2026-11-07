"use server";

import { revalidatePath } from "next/cache";

import { canInvite } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import {
  changeMemberRole,
  inviteMember,
  removeMember,
  revokeInvitation,
} from "@/services/provisioning";
import type { MembershipRole } from "@/types/domain";

/**
 * The team.
 *
 * Every action re-establishes who is asking AND re-derives the organisation
 * from the session. The org id is never taken from the form: a server action
 * is a public endpoint, so an id travelling through the request would be an
 * id the caller could change — and these are the writes that decide who may
 * act inside a tenant.
 */

export type { TeamFormState } from "@/components/team/team-form-state";

import type { TeamFormState } from "@/components/team/team-form-state";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

async function asAdmin(): Promise<
  { ok: true; orgId: string; userId: string } | { ok: false; error: string }
> {
  const session = await requireSession();
  if (!canInvite(session.activeRole)) {
    return { ok: false, error: "Only an admin can manage the team." };
  }
  return { ok: true, orgId: session.activeOrg.id, userId: session.userId };
}

export async function inviteMemberAction(
  _prev: TeamFormState,
  form: FormData
): Promise<TeamFormState> {
  const gate = await asAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };

  const email = field(form, "email");
  if (!email) return { ok: false, error: "Enter an email address." };

  const result = await inviteMember({
    orgId: gate.orgId,
    email,
    role: (field(form, "role") || "operator") as MembershipRole,
    invitedBy: gate.userId,
  });

  if (!result.ok) return result;

  revalidatePath("/team");
  return { ok: true, error: null };
}

export async function revokeInvitationAction(
  _prev: TeamFormState,
  form: FormData
): Promise<TeamFormState> {
  const gate = await asAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };

  const invitationId = field(form, "invitationId");
  if (!invitationId) return { ok: false, error: "No invitation was selected." };

  const result = await revokeInvitation({
    invitationId,
    revokedBy: gate.userId,
  });

  if (!result.ok) return result;

  revalidatePath("/team");
  return { ok: true, error: null };
}

export async function changeRoleAction(
  _prev: TeamFormState,
  form: FormData
): Promise<TeamFormState> {
  const gate = await asAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };

  const userId = field(form, "userId");
  const role = field(form, "role") as MembershipRole;
  if (!userId || !role) return { ok: false, error: "Nothing to change." };

  const result = await changeMemberRole({ orgId: gate.orgId, userId, role });
  if (!result.ok) return result;

  // A demoted operator sees a different board on their next request.
  revalidatePath("/", "layout");
  revalidatePath("/team");
  return { ok: true, error: null };
}

export async function removeMemberAction(
  _prev: TeamFormState,
  form: FormData
): Promise<TeamFormState> {
  const gate = await asAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };

  const userId = field(form, "userId");
  if (!userId) return { ok: false, error: "Nobody was selected." };

  const result = await removeMember({ orgId: gate.orgId, userId });
  if (!result.ok) return result;

  revalidatePath("/", "layout");
  revalidatePath("/team");
  return { ok: true, error: null };
}
