import type { MembershipRole } from "@/types/domain";

import { fail } from "./fail";
import { supabaseServer } from "./supabase/server";

/**
 * Provisioning: organisations, members and invitations.
 *
 * As everywhere in `src/services`, there is no org filter and no role check
 * here. RLS decides what these reads return and whether these writes land.
 */

export interface OrganisationSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  isSubscriber: boolean;
  timezone: string;
  memberCount: number;
  createdAt: string;
}

export interface OrgMember {
  userId: string;
  fullName: string | null;
  email: string;
  role: MembershipRole;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: MembershipRole;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

/** Every organisation the caller can see. For a platform admin, all of them. */
export async function listOrganisations(): Promise<OrganisationSummary[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("organisations")
    .select(
      "id, name, slug, status, is_subscriber, timezone, created_at, memberships(count)"
    )
    .order("name", { ascending: true });

  if (error) fail("load organisations", error);

  type Row = {
    id: string;
    name: string;
    slug: string;
    status: string;
    is_subscriber: boolean;
    timezone: string;
    created_at: string;
    memberships: { count: number }[];
  };

  return ((data ?? []) as unknown as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    isSubscriber: row.is_subscriber,
    timezone: row.timezone,
    // PostgREST returns an aggregate as a one-element array.
    memberCount: row.memberships?.[0]?.count ?? 0,
    createdAt: row.created_at,
  }));
}

export async function createOrganisation(input: {
  name: string;
  slug: string;
  isSubscriber: boolean;
  createdBy: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await supabaseServer();

  const { error } = await supabase.from("organisations").insert({
    name: input.name.trim(),
    slug: input.slug.trim().toLowerCase(),
    is_subscriber: input.isSubscriber,
    created_by: input.createdBy,
  });

  if (error) {
    // Constraint names are not an error message for a human.
    if (error.message.includes("organisations_slug_key")) {
      return { ok: false, error: "That short name is already taken." };
    }
    if (error.message.includes("organisations_slug_check")) {
      return {
        ok: false,
        error:
          "The short name may only contain lowercase letters, numbers and hyphens.",
      };
    }
    if (error.message.includes("row-level security")) {
      return { ok: false, error: "Only the platform owner can create organisations." };
    }
    return { ok: false, error: "Could not create the organisation." };
  }

  return { ok: true, error: null };
}

/**
 * The team.
 *
 * Goes through the `org_members` RPC rather than a table read: names and email
 * addresses live in `auth.users` and `profiles`, which RLS deliberately keeps
 * own-row-only. The function returns exactly the five fields this screen
 * renders, and checks the caller is an admin of that organisation on its first
 * line.
 */
export async function listMembers(orgId: string): Promise<OrgMember[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase.rpc("org_members", { target_org: orgId });

  if (error) fail("load members", error);

  type Row = {
    user_id: string;
    full_name: string | null;
    email: string;
    role: MembershipRole;
    created_at: string;
  };

  return ((data ?? []) as Row[]).map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
  }));
}

export async function listInvitations(orgId: string): Promise<Invitation[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("invitations")
    .select("id, email, role, created_at, accepted_at, revoked_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) fail("load invitations", error);

  type Row = {
    id: string;
    email: string;
    role: MembershipRole;
    created_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  };

  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  }));
}

export async function inviteMember(input: {
  orgId: string;
  email: string;
  role: MembershipRole;
  invitedBy: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await supabaseServer();

  // The database requires a normalised address; normalising here produces a
  // better outcome than a constraint violation.
  const email = input.email.trim().toLowerCase();

  const { error } = await supabase.from("invitations").insert({
    org_id: input.orgId,
    email,
    role: input.role,
    invited_by: input.invitedBy,
  });

  if (error) {
    if (error.message.includes("invitations_pending_idx")) {
      return { ok: false, error: "That address already has a pending invitation." };
    }
    if (error.message.includes("invitations_email_check")) {
      return { ok: false, error: "That does not look like an email address." };
    }
    if (error.message.includes("row-level security")) {
      return { ok: false, error: "Only an admin of this organisation can invite." };
    }
    return { ok: false, error: "Could not create the invitation." };
  }

  return { ok: true, error: null };
}

/** Revoked, never deleted: who was invited and withdrawn is part of the record. */
export async function revokeInvitation(input: {
  invitationId: string;
  revokedBy: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await supabaseServer();

  const { error } = await supabase
    .from("invitations")
    .update({ revoked_at: new Date().toISOString(), revoked_by: input.revokedBy })
    .eq("id", input.invitationId);

  if (error) return { ok: false, error: "Could not revoke the invitation." };
  return { ok: true, error: null };
}

/**
 * Claim any invitation addressed to the signed-in user's own verified email.
 *
 * For somebody invited after they already had an account: the signup trigger
 * fires once and cannot help them. Returns how many were claimed.
 */
export async function claimInvitations(): Promise<number> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("claim_invitations");
  if (error) fail("claim invitations", error);
  return (data as number) ?? 0;
}

/**
 * The slug the old demo seed used.
 *
 * That seed has been deleted, so nothing can create this organisation again —
 * this constant exists only so an owner whose project still carries the demo
 * rows can clear them. Nothing else may ever be removed by that control.
 */
export const DEMO_SLUG = "demo-logistics";

export interface SetupResult {
  ok: boolean;
  orgId: string | null;
  error: string | null;
}

/**
 * Create an organisation and put the caller in it as its admin.
 *
 * TWO WRITES, NOT ONE, AND NOT A TRANSACTION. PostgREST has no multi-statement
 * transaction, so the organisation can exist for a moment with nobody in it.
 * That is survivable — an empty organisation is visible to the platform owner
 * and can be finished or deleted — whereas the alternative, a `security
 * definer` function that creates both, would be a second privileged write path
 * into `memberships` existing only to save a round trip.
 *
 * The membership insert is permitted by the `is_platform_admin()` branch of
 * `memberships_insert_admin`. That branch is why there is no invite-and-claim
 * dance here: the owner is in the organisation the moment it exists.
 */
export async function createOrganisationWithAdmin(input: {
  name: string;
  slug: string;
  timezone: string;
  userId: string;
}): Promise<SetupResult> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("organisations")
    .insert({
      name: input.name.trim(),
      slug: input.slug.trim().toLowerCase(),
      timezone: input.timezone,
      is_subscriber: true,
      created_by: input.userId,
    })
    .select("id")
    .single();

  if (error || !data) {
    if (error?.message.includes("organisations_slug_key")) {
      return { ok: false, orgId: null, error: "That short name is already taken." };
    }
    if (error?.message.includes("organisations_slug_check")) {
      return {
        ok: false,
        orgId: null,
        error: "The short name may only contain lowercase letters, numbers and hyphens.",
      };
    }
    if (error?.message.includes("row-level security")) {
      return {
        ok: false,
        orgId: null,
        error: "Only the platform owner can create an organisation.",
      };
    }
    return { ok: false, orgId: null, error: "Could not create the organisation." };
  }

  const { error: membershipError } = await supabase.from("memberships").insert({
    org_id: data.id,
    user_id: input.userId,
    role: "admin",
  });

  if (membershipError) {
    // Say which half landed. "Something went wrong" after a partial write is
    // how somebody ends up creating the same organisation three times.
    return {
      ok: false,
      orgId: data.id,
      error:
        "The organisation was created, but you were not added to it. " +
        "Open it from the list and invite yourself as an admin.",
    };
  }

  return { ok: true, orgId: data.id, error: null };
}

/**
 * Remove the demo organisation, and everything that hangs off it.
 *
 * SCOPED TO ONE SLUG ON PURPOSE. The caller cannot name the target: a control
 * that deletes whatever it is handed, guarded by a confirmation box, is a
 * worse control than one that can only ever do the single thing it is for.
 * This cascades to locations, shipments, checkpoints, tasks and announcements,
 * which is far too much reach to leave pointable.
 */
export async function deleteDemoOrganisation(): Promise<{
  ok: boolean;
  error: string | null;
}> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("organisations")
    .delete()
    .eq("slug", DEMO_SLUG)
    .select("id");

  if (error) {
    if (error.message.includes("row-level security")) {
      return { ok: false, error: "Only the platform owner can remove the demo data." };
    }
    return { ok: false, error: "Could not remove the demo data." };
  }

  // A `using` failure does not raise — the delete simply matches no rows.
  if (!data || data.length === 0) {
    return { ok: false, error: "There is no demo organisation to remove." };
  }

  return { ok: true, error: null };
}

/**
 * Change what a colleague may do.
 *
 * `memberships_guard_last_admin` refuses the demotion of the last admin and
 * raises a sentence a person can read. That message is surfaced rather than
 * re-implemented here: two copies of the same rule drift, and the copy in the
 * database is the one that is actually enforced.
 */
export async function changeMemberRole(input: {
  orgId: string;
  userId: string;
  role: MembershipRole;
}): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("memberships")
    .update({ role: input.role })
    .eq("org_id", input.orgId)
    .eq("user_id", input.userId)
    .select("id");

  if (error) {
    if (error.message.includes("no admin")) {
      return {
        ok: false,
        error: "Somebody has to stay an admin. Promote another member first.",
      };
    }
    if (error.message.includes("row-level security")) {
      return { ok: false, error: "Only an admin can change roles." };
    }
    return { ok: false, error: "Could not change the role." };
  }

  // A `using` failure raises nothing — the update simply matches no rows.
  if (!data || data.length === 0) {
    return { ok: false, error: "That person is not in this organisation." };
  }

  return { ok: true, error: null };
}

/**
 * Take somebody out of the organisation.
 *
 * A real delete, unlike almost everything else here — a membership is a
 * CURRENT fact about who may act, not a record of something that happened.
 * The history that matters is kept elsewhere: their assignments, checkpoints
 * and messages all survive, and `is_assigned_to_shipment` re-checks
 * membership, so a removed person loses sight of every load immediately
 * without any of their work disappearing with them.
 */
export async function removeMember(input: {
  orgId: string;
  userId: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("memberships")
    .delete()
    .eq("org_id", input.orgId)
    .eq("user_id", input.userId)
    .select("id");

  if (error) {
    if (error.message.includes("no admin")) {
      return {
        ok: false,
        error: "Somebody has to stay an admin. Promote another member first.",
      };
    }
    if (error.message.includes("row-level security")) {
      return { ok: false, error: "Only an admin can remove people." };
    }
    return { ok: false, error: "Could not remove them." };
  }

  if (!data || data.length === 0) {
    return { ok: false, error: "That person is not in this organisation." };
  }

  return { ok: true, error: null };
}

/**
 * Change an organisation's own details.
 *
 * Only five fields, and that is not this function's choice — it is the
 * `grant update (...)` column list in 0001. RLS filters rows; it cannot say
 * "you may edit the name but not the suspension status", so column
 * privileges do that, and `slug`, `status` and `is_subscriber` are simply not
 * in the list. A write naming one of them is refused by the database before
 * any policy is consulted.
 */
export async function updateOrganisation(input: {
  orgId: string;
  name: string;
  timezone: string;
  contactEmail: string | null;
  registrationNumber: string | null;
  defaultSilenceThresholdDays: number | null;
}): Promise<{ ok: boolean; error: string | null }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the organisation a name." };

  const supabase = await supabaseServer();

  const patch: Record<string, string | number | null> = {
    name,
    timezone: input.timezone,
    // Lowercased because the column's check constraint demands it, and
    // somebody typing an address with a capital is not making a mistake worth
    // a constraint violation.
    contact_email: input.contactEmail?.trim().toLowerCase() ?? null,
    registration_number: input.registrationNumber,
  };

  if (input.defaultSilenceThresholdDays !== null) {
    patch.default_silence_threshold_days = input.defaultSilenceThresholdDays;
  }

  const { data, error } = await supabase
    .from("organisations")
    .update(patch)
    .eq("id", input.orgId)
    .select("id");

  if (error) {
    if (error.message.includes("organisations_name_check")) {
      return { ok: false, error: "Give the organisation a name." };
    }
    if (error.message.includes("contact_email")) {
      return { ok: false, error: "That does not look like an email address." };
    }
    if (error.message.includes("default_silence_threshold_days")) {
      return { ok: false, error: "The silence threshold has to be between 1 and 30 days." };
    }
    if (error.message.includes("row-level security")) {
      return { ok: false, error: "Only an admin can change these settings." };
    }
    return { ok: false, error: "Could not save the settings." };
  }

  // A `using` failure raises nothing — the update simply matches no rows.
  if (!data || data.length === 0) {
    return { ok: false, error: "That organisation is not yours to change." };
  }

  return { ok: true, error: null };
}

/** The five editable fields, for the settings form. */
export async function loadOrganisationDetails(orgId: string): Promise<{
  name: string;
  slug: string;
  timezone: string;
  contactEmail: string | null;
  registrationNumber: string | null;
  defaultSilenceThresholdDays: number;
} | null> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("organisations")
    .select(
      "name, slug, timezone, contact_email, registration_number, default_silence_threshold_days"
    )
    .eq("id", orgId)
    .maybeSingle();

  if (error) fail("load the organisation", error);
  if (!data) return null;

  const row = data as unknown as {
    name: string;
    slug: string;
    timezone: string;
    contact_email: string | null;
    registration_number: string | null;
    default_silence_threshold_days: number;
  };

  return {
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    contactEmail: row.contact_email,
    registrationNumber: row.registration_number,
    defaultSilenceThresholdDays: row.default_silence_threshold_days,
  };
}
