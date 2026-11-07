import type { PartyRole } from "@/types/domain";

import { describeFailure, fail } from "./fail";
import { supabaseServer } from "./supabase/server";

/**
 * Who else may watch this load.
 *
 * THIS IS THE PRODUCT. Everything else records a journey for the business
 * that owns it; this is what lets the consignee, the consignor or the broker
 * see it too — and it is the one place where data deliberately crosses a
 * tenant boundary.
 *
 * The asymmetry is absolute on everything except messages: a party reads, and
 * never writes. Nothing here can grant more than that, because nothing here
 * writes a policy — `shipment_parties` IS the grant, and `can_view_shipment`
 * is what reads it.
 */

export interface PartyGrant {
  id: string;
  partyOrgId: string;
  partyOrgName: string;
  partyRole: PartyRole;
  messagingEnabled: boolean;
  grantedAt: string;
  revokedAt: string | null;
}

export interface CounterpartyMatch {
  id: string;
  name: string;
  slug: string;
}

export interface WriteResult {
  ok: boolean;
  error: string | null;
}

const PARTY_COLUMNS =
  "id, party_org_id, party_role, messaging_enabled, created_at, revoked_at, organisations!shipment_parties_party_org_id_fkey(name)";

function describe(message: string, fallback: string): string {
  if (message.includes("shipment_parties_active_idx")) {
    return "That organisation already has this role on this shipment.";
  }
  if (message.includes("shipment_parties_not_owner")) {
    return "An organisation does not need a grant for its own shipment.";
  }
  if (message.includes("row-level security")) {
    return "Only an admin of the owning organisation can share a shipment.";
  }
  return fallback;
}

/** Every grant on one shipment, live ones first. */
export async function listParties(shipmentId: string): Promise<PartyGrant[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("shipment_parties")
    .select(PARTY_COLUMNS)
    .eq("shipment_id", shipmentId)
    .order("created_at", { ascending: true });

  if (error) fail("load the parties to this shipment", error);

  type Row = {
    id: string;
    party_org_id: string;
    party_role: PartyRole;
    messaging_enabled: boolean;
    created_at: string;
    revoked_at: string | null;
    organisations: { name: string } | null;
  };

  return ((data ?? []) as unknown as Row[]).map((row) => ({
    id: row.id,
    partyOrgId: row.party_org_id,
    partyOrgName: row.organisations?.name ?? "Unknown organisation",
    partyRole: row.party_role,
    messagingEnabled: row.messaging_enabled,
    grantedAt: row.created_at,
    revokedAt: row.revoked_at,
  }));
}

/**
 * What a lookup can come back as.
 *
 * THREE OUTCOMES, NOT TWO, and collapsing them was a real bug. The first
 * version returned `null` for every failure, so an admin on a database that
 * did not yet have `find_organisation_by_slug` was told "no organisation has
 * that short name" — which is a confident statement about somebody else's
 * data, made by code that had not been able to look. They would have gone
 * back to the customer to ask for a name they already had right.
 *
 * "Not found" and "could not look" are different answers and the interface
 * has to be able to say which.
 */
export type CounterpartyLookup =
  | { status: "found"; organisation: CounterpartyMatch }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

/**
 * Resolve a counterparty by its exact short name.
 *
 * Goes through the `find_organisation_by_slug` RPC rather than a table read,
 * because the table deliberately hides an organisation you share nothing with
 * — which is every organisation, right up until the moment you make the first
 * grant. See 0009 for why this exists and what it is bounded by.
 */
export async function findCounterparty(slug: string): Promise<CounterpartyLookup> {
  const trimmed = slug.trim().toLowerCase();
  if (!trimmed) return { status: "not_found" };

  const supabase = await supabaseServer();

  const { data, error } = await supabase.rpc("find_organisation_by_slug", {
    target_slug: trimmed,
  });

  if (error) {
    // The function is not in the database yet. `describeFailure` writes the
    // paragraph that says which migration adds it.
    if (error.code === "PGRST202" || /schema cache|does not exist/i.test(error.message)) {
      return {
        status: "unavailable",
        reason: describeFailure("look up that organisation", error),
      };
    }
    // Its own authorisation check refused: the caller is not an admin of any
    // organisation. Said plainly rather than dressed up as "not found".
    if (error.message.includes("Only an organisation admin")) {
      return {
        status: "unavailable",
        reason: "Only an admin can look up a customer by short name.",
      };
    }
    return { status: "unavailable", reason: "The lookup failed. Try again." };
  }

  const rows = (data ?? []) as CounterpartyMatch[];
  return rows[0]
    ? { status: "found", organisation: rows[0] }
    : { status: "not_found" };
}

/**
 * Give an organisation sight of one shipment.
 *
 * `messaging_enabled` is NOT set here, so it takes its default of false. 0007
 * chose that default so applying it did not retroactively open every existing
 * grant into a message channel; turning it on at grant time would undo that
 * decision quietly. It is a separate, deliberate switch.
 */
export async function grantParty(input: {
  orgId: string;
  shipmentId: string;
  partyOrgId: string;
  partyRole: PartyRole;
  grantedBy: string;
}): Promise<WriteResult> {
  if (input.partyOrgId === input.orgId) {
    return { ok: false, error: "That is your own organisation." };
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.from("shipment_parties").insert({
    org_id: input.orgId,
    shipment_id: input.shipmentId,
    party_org_id: input.partyOrgId,
    party_role: input.partyRole,
    granted_by: input.grantedBy,
  });

  if (error) return { ok: false, error: describe(error.message, "Could not share the shipment.") };
  return { ok: true, error: null };
}

/**
 * Take the view away.
 *
 * An UPDATE, never a DELETE: "you could see this from the 4th to the 9th" is
 * part of the oversight record, and a deleted row cannot say it. Revocation
 * bites on the next query — `can_view_shipment` carries the same
 * `revoked_at is null` clause the grant does.
 */
export async function revokeParty(input: {
  partyId: string;
  revokedBy: string;
}): Promise<WriteResult> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("shipment_parties")
    .update({ revoked_at: new Date().toISOString(), revoked_by: input.revokedBy })
    .eq("id", input.partyId)
    .is("revoked_at", null)
    .select("id");

  if (error) return { ok: false, error: describe(error.message, "Could not revoke the grant.") };
  if (!data || data.length === 0) {
    return { ok: false, error: "That grant is not yours to revoke." };
  }

  return { ok: true, error: null };
}

/** Open or close the message channel on a live grant. */
export async function setPartyMessaging(
  partyId: string,
  enabled: boolean
): Promise<WriteResult> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("shipment_parties")
    .update({ messaging_enabled: enabled })
    .eq("id", partyId)
    .is("revoked_at", null)
    .select("id");

  if (error) return { ok: false, error: describe(error.message, "Could not change messaging.") };
  if (!data || data.length === 0) {
    return { ok: false, error: "That grant is not yours to change." };
  }

  return { ok: true, error: null };
}
