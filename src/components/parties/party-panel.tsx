"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { PartyGrant } from "@/services/parties";
import type { PartyRole } from "@/types/domain";

import { EMPTY_FORM_STATE, type PartyFormState } from "./party-form-state";

/**
 * Who outside this business can watch the load.
 *
 * THE SHARE BOX ASKS FOR AN EXACT SHORT NAME, NOT A SEARCH TERM, and that is
 * the product working rather than an unfinished feature. A tenant you share
 * nothing with is invisible to you by policy — the alternative, a searchable
 * directory of organisations, would hand every carrier a list of their
 * competitors' customers. So the customer tells you their short name, the way
 * they would tell you an account number, and it resolves to exactly one
 * organisation or to nothing.
 *
 * MESSAGING IS A SECOND, SEPARATE SWITCH. Granting sight is read-only;
 * enabling messages lets another tenant write a row in this database. Those
 * are different decisions and the interface keeps them apart.
 */

type Action = (prev: PartyFormState, form: FormData) => Promise<PartyFormState>;

const ROLES: [PartyRole, string][] = [
  ["consignee", "Consignee — receiving the load"],
  ["consignor", "Consignor — sending it"],
  ["broker", "Broker"],
  ["carrier", "Carrier"],
  ["insurer", "Insurer"],
  ["notify_party", "Notify party"],
  ["other", "Other"],
];

const ROLE_LABEL: Record<PartyRole, string> = {
  consignee: "Consignee",
  consignor: "Consignor",
  broker: "Broker",
  carrier: "Carrier",
  insurer: "Insurer",
  notify_party: "Notify party",
  other: "Other",
};

function RowButton({
  action,
  fields,
  label,
  pendingLabel,
  variant = "ghost",
}: {
  action: Action;
  fields: Record<string, string>;
  label: string;
  pendingLabel: string;
  variant?: "ghost" | "secondary";
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={submit} className="flex items-center gap-2">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" variant={variant} size="sm" disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      {state.error ? (
        <span role="alert" className="text-micro text-exception">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

export function PartyPanel({
  grants,
  grantAction,
  revokeAction,
  messagingAction,
}: {
  grants: PartyGrant[];
  grantAction: Action;
  revokeAction: Action;
  messagingAction: Action;
}) {
  const [state, submit, pending] = useActionState(grantAction, EMPTY_FORM_STATE);

  const live = grants.filter((g) => g.revokedAt === null);
  const past = grants.filter((g) => g.revokedAt !== null);

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-ink-200 bg-paper-raised p-panel">
      <header>
        <h2 className="text-lead font-semibold text-ink-950">
          Who else can see this
        </h2>
        <p className="mt-0.5 text-small text-ink-600">
          A customer you share this with sees the journey and nothing else —
          not your other loads, not your other depots. They can never change
          it.
        </p>
      </header>

      {live.length === 0 ? (
        <p className="rounded-control border border-dashed border-ink-200 px-3 py-4 text-center text-small text-ink-600">
          Nobody outside {""}
          this business can see this shipment.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {live.map((grant) => (
            <li
              key={grant.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-canvas/70 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-small text-ink-950">
                  {grant.partyOrgName}
                </span>
                <span className="block truncate text-micro text-ink-400">
                  {ROLE_LABEL[grant.partyRole]}
                  {grant.messagingEnabled ? " · can message you" : " · view only"}
                </span>
              </span>

              <span className="flex items-center gap-1">
                <RowButton
                  action={messagingAction}
                  fields={{
                    partyId: grant.id,
                    enabled: grant.messagingEnabled ? "false" : "true",
                  }}
                  label={grant.messagingEnabled ? "Turn off messages" : "Allow messages"}
                  pendingLabel="Saving…"
                />
                <RowButton
                  action={revokeAction}
                  fields={{ partyId: grant.id }}
                  label="Revoke"
                  pendingLabel="Revoking…"
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      <form action={submit} className="flex flex-col gap-2 border-t border-ink-100 pt-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="party-slug">Customer&rsquo;s short name</Label>
            <Input
              id="party-slug"
              name="slug"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="acme-retail"
              className="font-code"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="party-role">Their role</Label>
            <select
              id="party-role"
              name="partyRole"
              defaultValue="consignee"
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
            {pending ? "Sharing…" : "Share"}
          </Button>
        </div>

        <p className="text-micro text-ink-400">
          Ask them for it rather than guessing — it is the name in their own
          address bar. Messages stay off until you turn them on.
        </p>

        {state.error ? (
          <p
            role="alert"
            className="rounded-control bg-exception-bg px-3 py-2 text-small text-exception"
          >
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p
            role="status"
            className="rounded-control bg-ontime-bg px-3 py-2 text-small text-ontime"
          >
            Shared. They can see this shipment now.
          </p>
        ) : null}
      </form>

      {/* Revocation is a timestamp, not a delete, so the history is readable.
          "You could see this from the 4th to the 9th" is part of the record. */}
      {past.length > 0 ? (
        <details className="text-small">
          <summary className="cursor-pointer text-ink-600">
            {past.length} past {past.length === 1 ? "grant" : "grants"}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {past.map((grant) => (
              <li key={grant.id} className="text-micro text-ink-400">
                {grant.partyOrgName} · {ROLE_LABEL[grant.partyRole]} · revoked
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
