"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { MembershipRole } from "@/types/domain";

import { EMPTY_FORM_STATE, type TeamFormState } from "./team-form-state";

/**
 * Managing the people in an organisation.
 *
 * NOTHING HERE RE-IMPLEMENTS THE LAST-ADMIN RULE. The database refuses to
 * leave an organisation without one — `memberships_guard_last_admin` — and
 * raises a sentence worth reading. Checking it here as well would produce two
 * copies of one rule, and the copy that is actually enforced is the other
 * one. So the controls stay enabled and the refusal is shown.
 */

type Action = (prev: TeamFormState, form: FormData) => Promise<TeamFormState>;

const ROLES: [MembershipRole, string][] = [
  ["admin", "Admin"],
  ["operator", "Operator"],
  ["viewer", "Viewer"],
];

const SELECT =
  "h-9 rounded-control border border-ink-200 bg-paper px-2 text-small text-ink-950";

function Status({ state, success }: { state: TeamFormState; success: string }) {
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

export function InviteForm({ action }: { action: Action }) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={submit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="invite-email">Email address</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="person@company.co.za"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            name="role"
            defaultValue="operator"
            className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
          >
            {ROLES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? "Inviting…" : "Invite"}
        </Button>
      </div>

      {/* There is no service-role key in this project, so the app cannot
          create an auth user. Saying so beats an invitation that appears to
          work and then does nothing. */}
      <p className="text-micro text-ink-400">
        An operator sees only the shipments you put them on. The invitation is
        claimed the first time they sign in — create their user in Supabase
        under Authentication → Users if they do not have one yet.
      </p>

      <Status state={state} success="Invited." />
    </form>
  );
}

export function MemberRow({
  userId,
  name,
  email,
  role,
  isSelf,
  changeAction,
  removeAction,
}: {
  userId: string;
  name: string | null;
  email: string;
  role: MembershipRole;
  isSelf: boolean;
  changeAction: Action;
  removeAction: Action;
}) {
  const [roleState, changeRole, changing] = useActionState(
    changeAction,
    EMPTY_FORM_STATE
  );
  const [removeState, remove, removing] = useActionState(
    removeAction,
    EMPTY_FORM_STATE
  );

  const error = roleState.error ?? removeState.error;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-panel py-3 last:border-b-0">
      <span className="min-w-0">
        <span className="block truncate text-body text-ink-950">
          {name ?? email}
          {isSelf ? <span className="text-ink-400"> · you</span> : null}
        </span>
        {name ? (
          <span className="block truncate text-micro text-ink-400">{email}</span>
        ) : null}
        {error ? (
          <span role="alert" className="mt-1 block text-micro text-exception">
            {error}
          </span>
        ) : null}
      </span>

      <span className="flex items-center gap-2">
        <form action={changeRole} className="flex items-center gap-1.5">
          <input type="hidden" name="userId" value={userId} />
          <label htmlFor={`role-${userId}`} className="sr-only">
            Role for {name ?? email}
          </label>
          <select
            id={`role-${userId}`}
            name="role"
            defaultValue={role}
            className={SELECT}
            disabled={changing}
          >
            {ROLES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <Button type="submit" variant="ghost" size="sm" disabled={changing}>
            {changing ? "Saving…" : "Save"}
          </Button>
        </form>

        <form
          action={remove}
          onSubmit={(e) => {
            if (
              !window.confirm(
                `Remove ${name ?? email}? They lose sight of every shipment ` +
                  "immediately. Their recorded stages stay on the record."
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="userId" value={userId} />
          <Button type="submit" variant="ghost" size="sm" disabled={removing}>
            {removing ? "Removing…" : "Remove"}
          </Button>
        </form>
      </span>
    </li>
  );
}

export function RevokeInvitationButton({
  invitationId,
  action,
}: {
  invitationId: string;
  action: Action;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={submit} className="flex items-center gap-2">
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Revoking…" : "Revoke"}
      </Button>
      {state.error ? (
        <span role="alert" className="text-micro text-exception">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
