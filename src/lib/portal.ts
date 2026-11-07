import type { MembershipRole, PartyRole } from "@/types/domain";

/**
 * Which product a user gets, and what the counterparty vocabulary is called.
 *
 * Pure, so the branch is a unit test rather than a redirect loop discovered in
 * a browser. Two shells now exist — the carrier's operations app and the
 * counterparty portal — and getting this wrong does not render wrongly, it
 * bounces somebody between two layouts until the tab gives up.
 */

/** The shape `homeFor` needs. Deliberately not the full `Session`. */
export interface MembershipLike {
  organisation: { isSubscriber: boolean };
}

export type Home = "/" | "/portal";

/**
 * Where a signed-in user belongs.
 *
 * A SUBSCRIBER MEMBERSHIP WINS. Somebody who both runs a logistics business
 * and receives goods from another carrier lands in their own operations app,
 * because that is the product they pay for; the portal is still reachable by
 * its own URL. The reverse default would put a dispatcher in a customer
 * portal every morning.
 *
 * No memberships is NOT this function's problem — `requireSession` already
 * redirects to `/no-access`, and answering "/" here would send a
 * membership-less user into a shell that cannot render.
 */
export function homeFor(memberships: readonly MembershipLike[]): Home {
  return memberships.some((m) => m.organisation.isSubscriber) ? "/" : "/portal";
}

/** True when this user has no business in the carrier's operations app. */
export function isCounterpartyOnly(memberships: readonly MembershipLike[]): boolean {
  return memberships.length > 0 && !memberships.some((m) => m.organisation.isSubscriber);
}

/**
 * TRADE VOCABULARY IN, PLAIN WORDS OUT.
 *
 * The schema says `consignor` and `consignee`, which are the correct terms on
 * a waybill and the wrong ones on a screen — a small business sending a pallet
 * does not call itself a consignor. The database keeps the precise vocabulary;
 * this is where it becomes language somebody recognises.
 *
 * `broker`, `insurer` and `notify_party` keep their own names: those parties
 * are trade professionals who use them.
 */
const PARTY_LABELS: Record<PartyRole, string> = {
  consignor: "Sender",
  consignee: "Recipient",
  broker: "Broker",
  carrier: "Carrier",
  insurer: "Insurer",
  notify_party: "Notify party",
  other: "Other party",
};

export function partyRoleLabel(role: PartyRole): string {
  return PARTY_LABELS[role];
}

/**
 * Which panels the portal shows, from the links an organisation actually holds.
 *
 * ONE DASHBOARD, NOT TWO. An organisation can be both sender and recipient —
 * a wholesaler receives stock and ships orders — so the portal renders a
 * Sending panel when it holds a live `consignor` link and a Receiving panel
 * when it holds a live `consignee` link. Separate `/sending` and `/receiving`
 * routes would force a role switcher onto an organisation that does both, and
 * would 404 for one that does neither yet.
 *
 * A link in any other role still grants visibility, so such an organisation
 * sees the Receiving panel: watching is what every party role has in common.
 */
export interface LinkLike {
  partyRole: PartyRole;
  revokedAt: string | null;
}

export interface PortalSections {
  sending: boolean;
  receiving: boolean;
}

export function portalSections(links: readonly LinkLike[]): PortalSections {
  const live = links.filter((link) => link.revokedAt === null);

  return {
    sending: live.some((link) => link.partyRole === "consignor"),
    // Anything that is not a consignor link is a watching role, and watching
    // is what the Receiving panel is.
    receiving: live.some((link) => link.partyRole !== "consignor"),
  };
}

/**
 * Whether a counterparty user may act, as opposed to only watch.
 *
 * Mirrors `src/lib/roles.ts` for the portal: a counterparty organisation has
 * its own members with their own roles, and a `viewer` inside a sender company
 * should be able to follow a load without being able to raise a request that
 * commits the company to freight charges.
 */
export function canRaiseRequests(role: MembershipRole): boolean {
  return role === "admin" || role === "operator";
}

export function canFileEvidence(role: MembershipRole): boolean {
  return role === "admin" || role === "operator";
}
