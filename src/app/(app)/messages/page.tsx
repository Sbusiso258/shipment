import type { Metadata } from "next";

import { ConversationView } from "@/components/messages/conversation-view";
import { groupConversations } from "@/lib/conversations";
import { requireSession } from "@/services/bootstrap";
import { loadMessages } from "@/services/collaboration";
import { requestNow } from "@/services/oversight";

import { sendMessageAction } from "./actions";

export const metadata: Metadata = { title: "Messages" };

/**
 * Correspondence with customers, and internal notices.
 *
 * RLS decides what comes back: an admin sees their organisation's threads,
 * an operator sees only those about shipments they are on, and a customer
 * sees only the conversation about the load they were granted.
 */
export default async function MessagesPage() {
  const session = await requireSession();
  const nowMs = requestNow();

  const messages = await loadMessages(200);
  const conversations = groupConversations(messages, session.activeOrg.id);

  return (
    <main className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col gap-4 overflow-hidden px-4 py-6">
      <header className="shrink-0">
        <h1 className="text-title font-semibold text-ink-950">Messages</h1>
        <p className="mt-1 text-ink-600">
          One thread per customer per shipment. A message is correspondence
          about a journey — it never changes the journey itself.
        </p>
      </header>

      <ConversationView
        conversations={conversations}
        ownOrgId={session.activeOrg.id}
        nowMs={nowMs}
        action={sendMessageAction}
      />
    </main>
  );
}
