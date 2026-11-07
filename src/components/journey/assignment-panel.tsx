"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import type { Assignee } from "@/services/assignments";
import type { MembershipRole } from "@/types/domain";

import {
  EMPTY_FORM_STATE,
  type AssignmentFormState,
} from "./assignment-form-state";

/**
 * Who works this shipment.
 *
 * THE PANEL SAYS WHAT IT DOES, because what it does is not obvious: adding
 * somebody here is the only thing that puts this shipment on their board.
 * A control that silently grants access is one people use without meaning to.
 *
 * Admins are listed without a remove control and without being offered in the
 * picker — they already see every shipment the organisation owns, so an
 * assignment would neither grant nor remove anything. Saying so is better
 * than a disabled button nobody can explain.
 */

type Action = (prev: AssignmentFormState, form: FormData) => Promise<AssignmentFormState>;

const ROLE_LABEL: Record<MembershipRole, string> = {
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

function Status({ state }: { state: AssignmentFormState }) {
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
  return null;
}

function RemoveButton({ assignment, action }: { assignment: Assignee; action: Action }) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);
  const who = assignment.fullName ?? assignment.email;

  return (
    <form action={submit} className="flex items-center gap-2">
      <input type="hidden" name="assignmentId" value={assignment.assignmentId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
        <span className="sr-only"> {who} from this shipment</span>
      </Button>
      {state.error ? (
        <span role="alert" className="text-micro text-exception">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

export function AssignmentPanel({
  assignees,
  candidates,
  assignAction,
  removeAction,
}: {
  /** Everyone currently on the shipment, admins included. */
  assignees: Assignee[];
  /** Members who could be added — non-admins who are not already on it. */
  candidates: { userId: string; fullName: string | null; email: string; role: MembershipRole }[];
  assignAction: Action;
  removeAction: Action;
}) {
  const [state, submit, pending] = useActionState(assignAction, EMPTY_FORM_STATE);

  const working = assignees.filter((a) => a.role !== "admin");
  const admins = assignees.filter((a) => a.role === "admin");

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-ink-200 bg-paper-raised p-panel">
      <header>
        <h2 className="text-lead font-semibold text-ink-950">Who works this shipment</h2>
        <p className="mt-0.5 text-small text-ink-600">
          Operators and viewers see a shipment only when they are on this list.
          Admins see every shipment in the organisation.
        </p>
      </header>

      {working.length === 0 ? (
        <p className="rounded-control border border-dashed border-ink-200 px-3 py-4 text-center text-small text-ink-600">
          Nobody is on this shipment yet. Only admins can see it.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {working.map((person) => (
            <li
              key={person.assignmentId}
              className="flex items-center justify-between gap-3 rounded-control bg-canvas/70 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-small text-ink-950">
                  {person.fullName ?? person.email}
                </span>
                <span className="block truncate text-micro text-ink-400">
                  {ROLE_LABEL[person.role]}
                  {person.fullName ? ` · ${person.email}` : null}
                </span>
              </span>

              <RemoveButton assignment={person} action={removeAction} />
            </li>
          ))}
        </ul>
      )}

      {/* An admin who created the shipment is assigned to it by the database.
          Showing them in the list above with a Remove button would imply the
          removal does something; it would not. */}
      {admins.length > 0 ? (
        <p className="text-micro text-ink-400">
          {admins.length === 1 ? "An admin is" : `${admins.length} admins are`} also
          recorded on this shipment. Admins see it either way.
        </p>
      ) : null}

      {candidates.length === 0 ? (
        <p className="text-micro text-ink-400">
          Everyone else in this organisation is either an admin or already on it.
        </p>
      ) : (
        <form action={submit} className="flex flex-wrap gap-2">
          <select
            name="userId"
            required
            defaultValue=""
            aria-label="Person to add"
            className="h-10 min-w-0 flex-1 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
          >
            <option value="" disabled>
              Choose somebody…
            </option>
            {candidates.map((person) => (
              <option key={person.userId} value={person.userId}>
                {(person.fullName ?? person.email) + ` — ${ROLE_LABEL[person.role]}`}
              </option>
            ))}
          </select>

          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add to shipment"}
          </Button>
        </form>
      )}

      <Status state={state} />
    </section>
  );
}
