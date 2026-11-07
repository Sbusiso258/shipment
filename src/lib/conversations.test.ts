import { describe, expect, it } from "vitest";

import type { Message } from "@/types/domain";

import { conversationTitle, groupConversations } from "./conversations";

const OWN = "org-own";

function message(over: Partial<Message>): Message {
  return {
    id: "m1",
    orgId: OWN,
    shipmentId: null,
    shipmentReference: null,
    counterpartyOrgId: null,
    senderOrgId: OWN,
    senderOrgName: "Us",
    senderUserId: "u1",
    body: "Hello",
    retractedAt: null,
    createdAt: "2026-11-01T08:00:00.000Z",
    ...over,
  };
}

describe("groupConversations", () => {
  it("keeps the same customer on two loads as two threads", () => {
    // The answer to "where is it" depends on which "it".
    const threads = groupConversations(
      [
        message({ id: "a", counterpartyOrgId: "acme", shipmentId: "s1" }),
        message({ id: "b", counterpartyOrgId: "acme", shipmentId: "s2" }),
      ],
      OWN
    );
    expect(threads).toHaveLength(2);
  });

  it("puts internal traffic in one thread of its own", () => {
    const threads = groupConversations(
      [message({ id: "a" }), message({ id: "b" })],
      OWN
    );
    expect(threads).toHaveLength(1);
    expect(conversationTitle(threads[0])).toBe("Everyone in your organisation");
  });

  it("names the thread after the other side, not us", () => {
    const threads = groupConversations(
      [
        message({ id: "a", counterpartyOrgId: "acme", shipmentId: "s1" }),
        message({
          id: "b",
          counterpartyOrgId: "acme",
          shipmentId: "s1",
          senderOrgId: "acme",
          senderOrgName: "Acme Retail",
        }),
      ],
      OWN
    );
    expect(conversationTitle(threads[0])).toBe("Acme Retail");
  });

  it("orders threads newest first and messages oldest first", () => {
    const threads = groupConversations(
      [
        message({ id: "old", counterpartyOrgId: "a", shipmentId: "s1", createdAt: "2026-11-01T08:00:00.000Z" }),
        message({ id: "new", counterpartyOrgId: "b", shipmentId: "s2", createdAt: "2026-11-02T08:00:00.000Z" }),
        message({ id: "older", counterpartyOrgId: "a", shipmentId: "s1", createdAt: "2026-10-31T08:00:00.000Z" }),
      ],
      OWN
    );
    expect(threads[0].messages[0].id).toBe("new");
    expect(threads[1].messages.map((m) => m.id)).toEqual(["older", "old"]);
  });
});
