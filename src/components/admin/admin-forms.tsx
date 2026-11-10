"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export interface AdminFormState {
  ok: boolean;
  error: string | null;
}

const EMPTY: AdminFormState = { ok: false, error: null };

function Status({ state, success }: { state: AdminFormState; success: string }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="rounded-control bg-exception-bg px-3 py-2 text-small text-exception"
      >
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p
        role="status"
        className="rounded-control bg-ontime-bg px-3 py-2 text-small text-ontime"
      >
        {success}
      </p>
    );
  }
  return null;
}

export function CreateOrganisationForm({
  action,
}: {
  action: (prev: AdminFormState, form: FormData) => Promise<AdminFormState>;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-name">Name</Label>
          <Input id="org-name" name="name" required placeholder="Alpha Freight" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-slug">Short name</Label>
          <Input id="org-slug" name="slug" placeholder="alpha-freight" />
          <p className="text-micro text-ink-400">
            Lowercase, hyphens. Left blank, it is taken from the name.
          </p>
        </div>
      </div>

      <label className="flex items-center gap-2 text-small text-ink-800">
        <input
          type="checkbox"
          name="isSubscriber"
          defaultChecked
          className="size-4 rounded border-ink-200"
        />
        Records its own shipments
        <span className="text-ink-400">
          — leave unticked for a counterparty that only ever views
        </span>
      </label>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create organisation"}
        </Button>
      </div>

      <Status state={state} success="Organisation created." />
    </form>
  );
}

export function InviteForm({
  action,
}: {
  action: (prev: AdminFormState, form: FormData) => Promise<AdminFormState>;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Input
          name="email"
          type="email"
          required
          placeholder="person@company.co.za"
          aria-label="Email address"
          className="min-w-0 flex-1"
        />
        <select
          name="role"
          defaultValue="operator"
          aria-label="Role"
          className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
        >
          <option value="admin">Admin</option>
          <option value="operator">Operator</option>
          <option value="viewer">Viewer</option>
        </select>
        <Button type="submit" disabled={pending}>
          {pending ? "Inviting…" : "Invite"}
        </Button>
      </div>

      <Status
        state={state}
        success="Invitation created. Now add the user in the Supabase dashboard."
      />
    </form>
  );
}

export function RevokeButton({
  invitationId,
  action,
}: {
  invitationId: string;
  action: (prev: AdminFormState, form: FormData) => Promise<AdminFormState>;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY);

  return (
    <form action={submit}>
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Revoking…" : "Revoke"}
      </Button>
      {state.error ? (
        <span role="alert" className="ml-2 text-micro text-exception">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
