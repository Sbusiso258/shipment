import type { Metadata } from "next";

import { ClaimInvitations } from "@/components/shell/claim-invitations";
import { Button } from "@/components/ui/button";

import { signOut } from "../(auth)/login/actions";
import { claimInvitationsAction } from "./actions";

export const metadata: Metadata = { title: "No access yet" };

/**
 * Signed in, but not yet a member of any organisation.
 *
 * An expected state, not an error. Access to this platform is granted by the
 * platform owner rather than taken at signup, so somebody can have a valid
 * account before anyone has put them in an organisation. Showing an empty
 * dashboard instead would read as a broken product.
 */
export default function NoAccessPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 px-4 py-16">
      <div>
        <p className="font-code text-micro uppercase tracking-widest text-marine-500">
          Shipment Oversight
        </p>
        <h1 className="text-title font-semibold text-ink-950">
          You are signed in, but not in an organisation yet
        </h1>
      </div>

      <div className="rounded-panel border border-ink-200 bg-paper p-5 shadow-panel">
        <p className="text-ink-800">
          Access here is granted deliberately rather than by signing up, so an
          account exists before it is attached to anything.
        </p>
        <p className="mt-3 text-ink-600">
          Ask whoever invited you to add you to their organisation. Once they
          have, this page will be replaced by their shipment board next time you
          sign in.
        </p>
      </div>

      {/* The way out for somebody invited after their account already
          existed. Without it they sit here indefinitely with a pending
          invitation nothing will ever action — a dead end with no error
          message, which is the worst kind. */}
      <ClaimInvitations action={claimInvitationsAction} />

      <form action={signOut}>
        <Button type="submit" variant="secondary">
          Sign out
        </Button>
      </form>
    </main>
  );
}
