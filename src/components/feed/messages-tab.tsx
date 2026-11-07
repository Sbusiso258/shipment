"use client";

import { Building2, Users } from "lucide-react";

import { formatSince } from "@/lib/duration";
import { cn } from "@/lib/utils";
import type { Message } from "@/types/domain";

/**
 * Recent correspondence.
 *
 * Two kinds of message share this list, and the difference matters enough to
 * be visible at a glance: an INTERNAL note to the organisation's own staff,
 * and a TWO-PARTY exchange with a customer about one shipment. Mixing them
 * without a visual distinction is how somebody says something internal to a
 * customer.
 */
export function MessagesTab({
  messages,
  ownOrgId,
  nowMs,
}: {
  messages: Message[];
  ownOrgId: string;
  nowMs: number;
}) {
  if (messages.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-small text-ink-400">
        No messages yet. Notes to your own team and conversations with
        customers about a shipment both appear here.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-list">
      {messages.map((message) => {
        const external = message.counterpartyOrgId !== null;
        const fromUs = message.senderOrgId === ownOrgId;

        return (
          <li
            key={message.id}
            className={cn(
              "rounded-panel border p-3",
              external
                ? "border-delivered/30 bg-delivered-bg/30"
                : "border-ink-200 bg-paper-raised"
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                {external ? (
                  <Building2 aria-hidden className="size-3.5 shrink-0 text-delivered" />
                ) : (
                  <Users aria-hidden className="size-3.5 shrink-0 text-ink-400" />
                )}
                <span className="truncate text-small font-medium text-ink-950">
                  {fromUs ? "You" : (message.senderOrgName ?? "A counterparty")}
                </span>
              </span>
              <time className="shrink-0 font-code text-micro text-ink-400">
                {formatSince(new Date(message.createdAt), new Date(nowMs))}
              </time>
            </div>

            {message.retractedAt ? (
              // Retracted, not deleted — that something was withdrawn is part
              // of the record.
              <p className="mt-1 text-small italic text-ink-400">
                This message was retracted.
              </p>
            ) : (
              <p className="mt-1 text-small text-ink-800">{message.body}</p>
            )}

            <p className="mt-1.5 text-micro text-ink-400">
              {message.shipmentReference ? (
                <span className="font-code">{message.shipmentReference}</span>
              ) : (
                "Everyone in your organisation"
              )}
              {external ? " · with a customer" : " · internal"}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
