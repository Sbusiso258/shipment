"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/services/bootstrap";
import { sendMessage } from "@/services/collaboration";

/**
 * Replying.
 *
 * `sendMessage` has existed since 0007 and has been covered by `verify:rls`
 * the whole time; nothing reached it until now, because there was no box to
 * type in.
 *
 * TWO RULES FROM 0007 CARRY OVER AND ARE NOT SOFTENED HERE:
 *
 *   `sender_org_id` and `sender_user_id` come from the SESSION, never from
 *   the form. A client that could name its own sender could impersonate the
 *   carrier to its own customer, which is a trust leak rather than a data
 *   leak and the worse of the two.
 *
 *   A party may only write where `messaging_enabled` is true on a live grant.
 *   That is enforced by the insert policy, not here — this check is for the
 *   message a person reads when it refuses.
 */

export type { MessageFormState } from "@/components/messages/message-form-state";

import type { MessageFormState } from "@/components/messages/message-form-state";

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function sendMessageAction(
  _prev: MessageFormState,
  form: FormData
): Promise<MessageFormState> {
  const session = await requireSession();

  const body = field(form, "body");
  if (!body) return { ok: false, error: "Write something first." };

  const result = await sendMessage({
    orgId: session.activeOrg.id,
    shipmentId: field(form, "shipmentId"),
    counterpartyOrgId: field(form, "counterpartyOrgId"),
    senderOrgId: session.activeOrg.id,
    senderUserId: session.userId,
    body,
  });

  if (!result.ok) return result;

  revalidatePath("/messages");
  revalidatePath("/");
  return { ok: true, error: null };
}
