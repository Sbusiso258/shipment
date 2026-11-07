import { describe, expect, it } from "vitest";

import type { MembershipRole } from "@/types/domain";

import {
  canAssignShipments,
  canEditShipments,
  canInvite,
  canLogCheckpoints,
  canManageLocations,
  canManageParties,
} from "./roles";

/**
 * A table, matching the one asserted in supabase/verify-rls.mjs. If the two
 * disagree, the interface is offering something the database refuses — or
 * hiding something it would allow.
 */
const MATRIX: Record<
  MembershipRole,
  {
    logCheckpoints: boolean;
    editShipments: boolean;
    manageParties: boolean;
    invite: boolean;
    manageLocations: boolean;
    assignShipments: boolean;
  }
> = {
  admin: {
    logCheckpoints: true,
    editShipments: true,
    manageParties: true,
    invite: true,
    manageLocations: true,
    assignShipments: true,
  },
  operator: {
    logCheckpoints: true,
    editShipments: true,
    // Granting a counterparty a permanent view of commercial movements is an
    // admin decision, not an operational one.
    manageParties: false,
    invite: false,
    manageLocations: true,
    // An operator who could assign themselves would make the whole narrowing
    // in 0008 voluntary.
    assignShipments: false,
  },
  viewer: {
    // The party asymmetry, in the UI: a viewer reads and never writes.
    logCheckpoints: false,
    editShipments: false,
    manageParties: false,
    invite: false,
    manageLocations: false,
    assignShipments: false,
  },
};

describe("role permissions", () => {
  for (const [role, expected] of Object.entries(MATRIX) as [
    MembershipRole,
    (typeof MATRIX)[MembershipRole],
  ][]) {
    it(`grants a ${role} exactly what the policies allow`, () => {
      expect(canLogCheckpoints(role)).toBe(expected.logCheckpoints);
      expect(canEditShipments(role)).toBe(expected.editShipments);
      expect(canManageParties(role)).toBe(expected.manageParties);
      expect(canInvite(role)).toBe(expected.invite);
      expect(canManageLocations(role)).toBe(expected.manageLocations);
      expect(canAssignShipments(role)).toBe(expected.assignShipments);
    });
  }

  it("never lets a viewer write anything", () => {
    expect(canLogCheckpoints("viewer")).toBe(false);
    expect(canEditShipments("viewer")).toBe(false);
    expect(canManageParties("viewer")).toBe(false);
    expect(canAssignShipments("viewer")).toBe(false);
  });

  it("lets only an admin decide who sees a shipment", () => {
    expect(canAssignShipments("admin")).toBe(true);
    expect(canAssignShipments("operator")).toBe(false);
    expect(canAssignShipments("viewer")).toBe(false);
  });
});
