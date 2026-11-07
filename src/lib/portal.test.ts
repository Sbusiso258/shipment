import { describe, expect, it } from "vitest";

import {
  canFileEvidence,
  canRaiseRequests,
  homeFor,
  isCounterpartyOnly,
  partyRoleLabel,
  portalSections,
} from "./portal";
import type { PartyRole } from "@/types/domain";

const sub = { organisation: { isSubscriber: true } };
const party = { organisation: { isSubscriber: false } };

describe("homeFor", () => {
  it("sends a logistics business to its operations app", () => {
    expect(homeFor([sub])).toBe("/");
  });

  it("sends a counterparty to the portal", () => {
    expect(homeFor([party])).toBe("/portal");
  });

  // A wholesaler who both ships and receives. The product they pay for wins;
  // the portal stays reachable by its own URL.
  it("prefers the operations app when somebody is both", () => {
    expect(homeFor([party, sub])).toBe("/");
    expect(homeFor([sub, party])).toBe("/");
  });

  // Not this function's job — `requireSession` redirects to /no-access first.
  // Answering "/" would send a membership-less user into a shell that cannot
  // render, so the test pins the behaviour rather than leaving it incidental.
  it("does not claim the operations app for somebody with no memberships", () => {
    expect(homeFor([])).toBe("/portal");
    expect(isCounterpartyOnly([])).toBe(false);
  });

  it("identifies a counterparty-only user", () => {
    expect(isCounterpartyOnly([party])).toBe(true);
    expect(isCounterpartyOnly([party, sub])).toBe(false);
  });
});

describe("partyRoleLabel", () => {
  // The schema's vocabulary is correct on a waybill and wrong on a screen.
  it("turns trade terms into words a small business recognises", () => {
    expect(partyRoleLabel("consignor")).toBe("Sender");
    expect(partyRoleLabel("consignee")).toBe("Recipient");
  });

  it("leaves the professional roles their own names", () => {
    expect(partyRoleLabel("broker")).toBe("Broker");
    expect(partyRoleLabel("insurer")).toBe("Insurer");
    expect(partyRoleLabel("notify_party")).toBe("Notify party");
  });

  it("has a label for every party role in the schema", () => {
    const all: PartyRole[] = [
      "consignor",
      "consignee",
      "broker",
      "carrier",
      "insurer",
      "notify_party",
      "other",
    ];
    for (const role of all) {
      expect(partyRoleLabel(role), role).toBeTruthy();
      expect(partyRoleLabel(role), role).not.toContain("_");
    }
  });
});

describe("portalSections", () => {
  const live = (partyRole: PartyRole) => ({ partyRole, revokedAt: null });

  it("shows Sending for a consignor link", () => {
    expect(portalSections([live("consignor")])).toEqual({
      sending: true,
      receiving: false,
    });
  });

  it("shows Receiving for a consignee link", () => {
    expect(portalSections([live("consignee")])).toEqual({
      sending: false,
      receiving: true,
    });
  });

  // THE CASE THAT MADE IT ONE DASHBOARD. Separate routes would force a role
  // switcher on this organisation.
  it("shows both for an organisation that ships and receives", () => {
    expect(portalSections([live("consignor"), live("consignee")])).toEqual({
      sending: true,
      receiving: true,
    });
  });

  // Watching is what every non-consignor role has in common, so a broker or
  // an insurer gets the Receiving panel rather than an empty page.
  it("treats a watching role as Receiving", () => {
    expect(portalSections([live("broker")]).receiving).toBe(true);
    expect(portalSections([live("insurer")]).receiving).toBe(true);
  });

  // The load-bearing clause, here as everywhere else in this schema: without
  // it, revoking a link would do nothing at all, silently.
  it("ignores a revoked link", () => {
    expect(
      portalSections([{ partyRole: "consignor", revokedAt: "2026-11-01T00:00:00.000Z" }])
    ).toEqual({ sending: false, receiving: false });
  });

  it("shows nothing for an organisation with no links yet", () => {
    expect(portalSections([])).toEqual({ sending: false, receiving: false });
  });
});

describe("portal capabilities", () => {
  // A viewer inside a sender company should follow a load without being able
  // to commit the company to freight charges.
  it("lets an admin and an operator act, and a viewer only watch", () => {
    expect(canRaiseRequests("admin")).toBe(true);
    expect(canRaiseRequests("operator")).toBe(true);
    expect(canRaiseRequests("viewer")).toBe(false);

    expect(canFileEvidence("admin")).toBe(true);
    expect(canFileEvidence("operator")).toBe(true);
    expect(canFileEvidence("viewer")).toBe(false);
  });
});
