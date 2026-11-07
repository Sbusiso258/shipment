import type { Message } from "@/types/domain";

/**
 * Messages, grouped the way people think about them.
 *
 * A conversation is a counterparty AND a shipment: the same customer asking
 * about two different loads is two threads, because the answer to "where is
 * it" depends on which "it". Internal organisation-wide traffic — no
 * counterparty, no shipment — is one more thread.
 *
 * Pure, and in `lib` because the grouping is a judgement about what the rows
 * mean. No clock is read here; `latestAt` is carried, not computed.
 */

export interface Conversation {
  /** Stable across renders: counterparty and shipment, or "internal". */
  key: string;
  counterpartyOrgId: string | null;
  counterpartyName: string | null;
  shipmentId: string | null;
  shipmentReference: string | null;
  messages: Message[];
  latestAt: string;
  /** A retracted message still counts as traffic; it just reads as withdrawn. */
  count: number;
}

export function conversationKey(message: Message): string {
  if (message.counterpartyOrgId === null && message.shipmentId === null) {
    return "internal";
  }
  return `${message.counterpartyOrgId ?? "own"}:${message.shipmentId ?? "any"}`;
}

/**
 * Newest conversation first, newest message last within each.
 *
 * The outer order is what somebody scanning a list wants; the inner order is
 * what somebody reading a thread wants. They are opposite on purpose.
 */
export function groupConversations(
  messages: Message[],
  ownOrgId: string
): Conversation[] {
  const grouped = new Map<string, Conversation>();

  for (const message of messages) {
    const key = conversationKey(message);
    const existing = grouped.get(key);

    if (existing) {
      existing.messages.push(message);
      existing.count += 1;
      if (message.createdAt > existing.latestAt) existing.latestAt = message.createdAt;
      continue;
    }

    // The counterparty's NAME is only carried on messages they sent — our own
    // rows name us. Fall back to whichever row has it.
    const counterpartyName =
      message.senderOrgId !== ownOrgId ? message.senderOrgName : null;

    grouped.set(key, {
      key,
      counterpartyOrgId: message.counterpartyOrgId,
      counterpartyName,
      shipmentId: message.shipmentId,
      shipmentReference: message.shipmentReference,
      messages: [message],
      latestAt: message.createdAt,
      count: 1,
    });
  }

  for (const conversation of grouped.values()) {
    if (conversation.counterpartyName === null) {
      const theirs = conversation.messages.find((m) => m.senderOrgId !== ownOrgId);
      conversation.counterpartyName = theirs?.senderOrgName ?? null;
    }
    conversation.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return [...grouped.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

/** What to call a thread in a list. */
export function conversationTitle(conversation: Conversation): string {
  if (conversation.counterpartyOrgId === null && conversation.shipmentId === null) {
    return "Everyone in your organisation";
  }
  return conversation.counterpartyName ?? "A customer";
}
