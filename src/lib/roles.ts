import type { MembershipRole } from "@/types/domain";

/**
 * What each role may do, as data.
 *
 * READ THIS BEFORE USING IT: these functions decide what to RENDER. They are
 * not the authorisation boundary — row-level security is. Hiding a button is
 * cosmetic, and a UI-only permission check is how a product ends up with an
 * authorisation bug that every manual test passes.
 *
 * The point of having them is that the interface should not offer an action
 * the database will refuse. A viewer shown a "record stage" form that always
 * fails has been lied to.
 *
 * The same table is asserted in `supabase/verify-rls.mjs`, so the UI's idea of
 * a role and the database's cannot drift apart silently.
 */

export function canLogCheckpoints(role: MembershipRole): boolean {
  return role === "admin" || role === "operator";
}

export function canEditShipments(role: MembershipRole): boolean {
  return role === "admin" || role === "operator";
}

export function canManageParties(role: MembershipRole): boolean {
  // Granting another organisation visibility is an admin decision: it hands a
  // counterparty a permanent view of commercial movements.
  return role === "admin";
}

export function canInvite(role: MembershipRole): boolean {
  return role === "admin";
}

export function canManageLocations(role: MembershipRole): boolean {
  return role === "admin" || role === "operator";
}

export function canAssignShipments(role: MembershipRole): boolean {
  // An assignment IS a read grant — it is what decides whether an operator
  // sees a load at all — so it belongs with the other admin decisions. An
  // operator who could assign themselves would make the restriction
  // voluntary, which is the same as not having one.
  return role === "admin";
}
