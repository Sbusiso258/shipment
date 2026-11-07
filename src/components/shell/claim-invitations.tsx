"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

export interface ClaimState {
  checked: boolean;
  claimed: number;
}

const EMPTY: ClaimState = { checked: false, claimed: 0 };

export function ClaimInvitations({
  action,
}: {
  action: () => Promise<ClaimState>;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY);

  return (
    <form action={submit} className="flex flex-col gap-2">
      <Button type="submit" disabled={pending}>
        {pending ? "Checking…" : "Check for an invitation"}
      </Button>

      {/* On success the action redirects, so the only state worth rendering is
          the empty-handed one. Saying "nothing found" plainly is better than a
          button that appears to do nothing. */}
      {state.checked && state.claimed === 0 ? (
        <p role="status" className="text-small text-ink-600">
          No invitation is waiting for this address yet.
        </p>
      ) : null}
    </form>
  );
}
