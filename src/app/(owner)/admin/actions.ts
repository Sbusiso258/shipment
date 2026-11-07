"use server";

import { revalidatePath } from "next/cache";

import { canInvite } from "@/lib/roles";
import { requireActor, requireSession } from "@/services/bootstrap";
import {
  createOrganisation,
  createOrganisationWithAdmin,
  deleteDemoOrganisation,
  inviteMember,
  revokeInvitation,
  DEMO_SLUG,
} from "@/services/provisioning";
import { clearOrganisationData } from "@/services/reset";
import type { MembershipRole } from "@/types/domain";

/**
 * Provisioning actions.
 *
 * Every one re-establishes who is asking. A server action is a public HTTP
 * endpoint, invocable directly — so the layout's `isPlatformAdmin` check
 * protects the screen, not the action.
 *
 * ALL OF THEM TAKE AN `Actor`, NOT A `Session`, and that is load-bearing
 * rather than tidiness. `requireSession` redirects a user with no membership
 * to /no-access, and the platform owner has no membership at the moment they
 * create the first organisation — so these three ran the screen's own layout
 * comment in reverse and sent the owner into a dead end. See `requireActor`.
 */

export interface AdminFormState {
  ok: boolean;
  error: string | null;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A slug offered as a default rather than demanded: one fewer field to think
 * about, and it is only ever used in URLs.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function createOrganisationAction(
  _prev: AdminFormState,
  form: FormData
): Promise<AdminFormState> {
  const actor = await requireActor();

  if (!actor.isPlatformAdmin) {
    return { ok: false, error: "Only the platform owner can create organisations." };
  }

  const name = field(form, "name");
  if (!name) return { ok: false, error: "Give the organisation a name." };

  const slug = field(form, "slug") || slugify(name);

  const result = await createOrganisation({
    name,
    slug,
    isSubscriber: form.get("isSubscriber") === "on",
    createdBy: actor.userId,
  });

  if (!result.ok) return result;

  revalidatePath("/admin");
  return { ok: true, error: null };
}

export async function inviteMemberAction(
  orgId: string,
  _prev: AdminFormState,
  form: FormData
): Promise<AdminFormState> {
  const actor = await requireActor();

  const isOrgAdmin =
    actor.memberships.some((m) => m.orgId === orgId && canInvite(m.role));

  if (!isOrgAdmin && !actor.isPlatformAdmin) {
    return { ok: false, error: "You cannot invite people to this organisation." };
  }

  const email = field(form, "email");
  if (!email) return { ok: false, error: "Enter an email address." };

  const result = await inviteMember({
    orgId,
    email,
    role: (field(form, "role") || "viewer") as MembershipRole,
    invitedBy: actor.userId,
  });

  if (!result.ok) return result;

  revalidatePath(`/admin/organisations/${orgId}`);
  return { ok: true, error: null };
}

export async function revokeInvitationAction(
  orgId: string,
  _prev: AdminFormState,
  form: FormData
): Promise<AdminFormState> {
  const actor = await requireActor();

  const isOrgAdmin =
    actor.memberships.some((m) => m.orgId === orgId && canInvite(m.role));

  if (!isOrgAdmin && !actor.isPlatformAdmin) {
    return { ok: false, error: "You cannot manage invitations here." };
  }

  const invitationId = field(form, "invitationId");
  if (!invitationId) return { ok: false, error: "No invitation was selected." };

  const result = await revokeInvitation({
    invitationId,
    revokedBy: actor.userId,
  });

  if (!result.ok) return result;

  revalidatePath(`/admin/organisations/${orgId}`);
  return { ok: true, error: null };
}

/**
 * Set the platform up for its first real organisation.
 *
 * Creates the organisation AND puts the owner in it as admin, so the board is
 * openable the moment this returns. Without the membership the owner would be
 * bounced to /no-access by the app's own layout — which is the trap this
 * screen exists to avoid.
 */
export async function setUpOrganisationAction(
  _prev: AdminFormState,
  form: FormData
): Promise<AdminFormState> {
  const actor = await requireActor();

  if (!actor.isPlatformAdmin) {
    return { ok: false, error: "Only the platform owner can do this." };
  }

  const name = field(form, "name");
  if (!name) return { ok: false, error: "What is the business called?" };

  const result = await createOrganisationWithAdmin({
    name,
    slug: field(form, "slug") || slugify(name),
    timezone: field(form, "timezone") || "Africa/Johannesburg",
    userId: actor.userId,
  });

  if (!result.ok) return { ok: false, error: result.error };

  // The shell, the board and the admin list all change the moment a
  // membership exists.
  revalidatePath("/", "layout");
  revalidatePath("/admin");
  return { ok: true, error: null };
}

/**
 * Remove the demo organisation and everything under it.
 *
 * The slug must be typed back. Not theatre: this cascades to every shipment,
 * checkpoint, location, task and announcement beneath it, and there is no undo
 * short of a database restore.
 *
 * The typed value is COMPARED, never used as the target. `deleteDemoOrganisation`
 * can only ever delete one slug, so even a caller invoking this endpoint
 * directly with another organisation's name gets nothing.
 */
export async function removeDemoDataAction(
  _prev: AdminFormState,
  form: FormData
): Promise<AdminFormState> {
  const actor = await requireActor();

  if (!actor.isPlatformAdmin) {
    return { ok: false, error: "Only the platform owner can remove the demo data." };
  }

  if (field(form, "confirm") !== DEMO_SLUG) {
    return { ok: false, error: `Type ${DEMO_SLUG} to confirm.` };
  }

  const result = await deleteDemoOrganisation();
  if (!result.ok) return result;

  revalidatePath("/", "layout");
  revalidatePath("/admin");
  return { ok: true, error: null };
}

/**
 * Empty the signed-in admin's organisation, so real data can go in.
 *
 * `requireSession`, not `requireActor`: this one needs an ACTIVE organisation,
 * and by the time anybody presses it they are in one. The organisation comes
 * from the session and never from the form — a server action is a public
 * endpoint, so an org id travelling through the request would be an id the
 * caller could change, on the single most destructive thing in the product.
 */
export async function clearOrganisationDataAction(
  _prev: AdminFormState,
  form: FormData
): Promise<AdminFormState> {
  const session = await requireSession();

  if (!canInvite(session.activeRole)) {
    return { ok: false, error: "Only an admin can clear this organisation's data." };
  }

  // The name typed back, compared — never used as the target.
  if (field(form, "confirm") !== session.activeOrg.name) {
    return { ok: false, error: `Type ${session.activeOrg.name} to confirm.` };
  }

  const result = await clearOrganisationData({
    orgId: session.activeOrg.id,
    userId: session.userId,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/", "layout");
  revalidatePath("/admin/setup");

  return { ok: true, error: null };
}
