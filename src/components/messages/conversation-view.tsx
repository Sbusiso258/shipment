"use client";

import { useActionState, useState } from "react";
import { Building2, Send, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  conversationTitle,
  type Conversation,
} from "@/lib/conversations";
import { formatSince } from "@/lib/duration";
import { cn } from "@/lib/utils";

import {
  EMPTY_FORM_STATE,
  type MessageFormState,
} from "./message-form-state";

/**
 * Correspondence, as conversations.
 *
 * A thread is a counterparty AND a shipment, because the same customer asking
 * about two loads is two different questions. Internal organisation-wide
 * traffic is one more thread.
 *
 * WHAT MAKES IT NOT A CHAT APP, and should stay that way: a message is
 * correspondence ABOUT a journey, never a claim about it. A consignee can ask
 * where the load is; they still cannot say it was delivered. Nothing typed
 * here touches a shipment, a checkpoint or `last_event_at` — a chatty
 * customer must not be able to silence the carrier's own "this load has gone
 * quiet" alarm by talking.
 */

type Action = (prev: MessageFormState, form: FormData) => Promise<MessageFormState>;

function Composer({
  conversation,
  action,
}: {
  conversation: Conversation;
  action: Action;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form
      action={submit}
      className="flex shrink-0 flex-col gap-2 border-t border-ink-200 p-3"
    >
      {/* Who it is to travels with the form; who it is FROM comes from the
          session on the server and is never sent. */}
      {conversation.shipmentId ? (
        <input type="hidden" name="shipmentId" value={conversation.shipmentId} />
      ) : null}
      {conversation.counterpartyOrgId ? (
        <input
          type="hidden"
          name="counterpartyOrgId"
          value={conversation.counterpartyOrgId}
        />
      ) : null}

      <div className="flex items-center gap-2">
        <Input
          // Keyed on success so a sent message clears the box.
          key={state.ok ? "sent" : "writing"}
          name="body"
          required
          autoComplete="off"
          placeholder={
            conversation.counterpartyOrgId
              ? `Reply to ${conversationTitle(conversation)}…`
              : "Message everyone in your organisation…"
          }
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={pending}>
          <Send aria-hidden />
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>

      {state.error ? (
        <p role="alert" className="text-small text-exception">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function ConversationView({
  conversations,
  ownOrgId,
  nowMs,
  action,
}: {
  conversations: Conversation[];
  ownOrgId: string;
  nowMs: number;
  action: Action;
}) {
  const [openKey, setOpenKey] = useState<string | null>(
    conversations[0]?.key ?? null
  );

  const open = conversations.find((c) => c.key === openKey) ?? null;
  const now = new Date(nowMs);

  if (conversations.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-ink-200 p-10 text-center">
        <p className="text-lead text-ink-950">No messages yet</p>
        <p className="max-w-sm text-small text-ink-400">
          A customer you have shared a shipment with can write to you here,
          once messaging is switched on for their grant. You can start a thread
          from the shipment itself.
        </p>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 gap-list lg:grid-cols-[18rem_minmax(0,1fr)]">
      {/* --- the threads ------------------------------------------------- */}
      <ul className="min-h-0 overflow-y-auto rounded-panel border border-ink-200 bg-paper p-2">
        {conversations.map((conversation) => {
          const current = conversation.key === openKey;
          const last = conversation.messages.at(-1);
          const internal = conversation.counterpartyOrgId === null;

          return (
            <li key={conversation.key}>
              <button
                type="button"
                onClick={() => setOpenKey(conversation.key)}
                aria-current={current ? "true" : undefined}
                className={cn(
                  "flex w-full items-start gap-2 rounded-control p-2 text-left transition-colors",
                  current ? "bg-ink-100" : "hover:bg-ink-100"
                )}
              >
                {internal ? (
                  <Users aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-400" />
                ) : (
                  <Building2
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-delivered"
                  />
                )}

                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-small font-medium text-ink-950">
                      {conversationTitle(conversation)}
                    </span>
                    <span className="shrink-0 text-micro text-ink-400">
                      {formatSince(new Date(conversation.latestAt), now)}
                    </span>
                  </span>

                  {conversation.shipmentReference ? (
                    <span className="block truncate font-code text-micro text-marine-200">
                      {conversation.shipmentReference}
                    </span>
                  ) : null}

                  <span className="block truncate text-micro text-ink-400">
                    {last?.retractedAt ? "Message retracted" : last?.body}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* --- the thread --------------------------------------------------- */}
      {open ? (
        <section className="flex min-h-0 flex-col rounded-panel border border-ink-200 bg-paper">
          <header className="shrink-0 border-b border-ink-200 px-panel py-3">
            <h2 className="text-lead font-medium text-ink-950">
              {conversationTitle(open)}
            </h2>
            <p className="text-micro text-ink-400">
              {open.shipmentReference
                ? `About ${open.shipmentReference}`
                : "Internal — nobody outside your organisation sees this"}
            </p>
          </header>

          <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            {open.messages.map((message) => {
              const mine = message.senderOrgId === ownOrgId;

              return (
                <li
                  key={message.id}
                  className={cn("flex", mine ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[32rem] rounded-panel px-3 py-2",
                      mine
                        ? "bg-marine-700 text-marine-on"
                        : "border border-ink-200 bg-paper-raised text-ink-950"
                    )}
                  >
                    {!mine ? (
                      <p className="text-micro opacity-70">
                        {message.senderOrgName ?? "A customer"}
                      </p>
                    ) : null}

                    <p className="whitespace-pre-wrap text-small">
                      {message.retractedAt ? (
                        <span className="italic opacity-70">
                          This message was retracted.
                        </span>
                      ) : (
                        message.body
                      )}
                    </p>

                    <p className="mt-0.5 text-right text-micro opacity-70">
                      {formatSince(new Date(message.createdAt), now)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>

          <Composer conversation={open} action={action} />
        </section>
      ) : null}
    </div>
  );
}
