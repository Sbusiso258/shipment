"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireUser } from "@/services/bootstrap";
import { claimInvitations } from "@/services/provisioning";

export interface ClaimState {
  checked: boolean;
  claimed: number;
}

/**
 * Check whether anyone has invited this account since it was created.
 *
 * `handle_new_user` fires once, at signup, so a user invited to an
 * organisation months later would otherwise sit here forever with a pending
 * invitation that nothing will ever action.
 */
export async function claimInvitationsAction(): Promise<ClaimState> {
  await requireUser();

  const claimed = await claimInvitations();

  if (claimed > 0) {
    revalidatePath("/", "layout");
    redirect("/");
  }

  return { checked: true, claimed: 0 };
}
