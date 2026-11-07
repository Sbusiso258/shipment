"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import type { Shipment } from "@/types/domain";

import {
  EMPTY_FORM_STATE,
  type ShipmentFormState,
} from "./shipment-form-state";

/**
 * Where a load is in its life.
 *
 * THESE BUTTONS SET TIMES, NOT STATUSES. `shipments_sync_status` derives
 * `in_transit` from `dispatched_at` and `delivered` from `delivered_at`, so a
 * control that wrote the status directly could disagree with the timestamps
 * and the product would tell the customer two different things. `on hold` is
 * the exception, because nothing derives it: a stopped load is a human
 * assertion, not a computation.
 *
 * Only the moves that are actually available are rendered. A disabled "Mark
 * delivered" on a shipment that has not left is a worse answer than no button,
 * because it implies the state is reachable from here.
 */

type Action = (prev: ShipmentFormState, form: FormData) => Promise<ShipmentFormState>;

function LifecycleButton({
  action,
  event,
  label,
  pendingLabel,
  variant = "secondary",
  confirm,
}: {
  action: Action;
  event: string;
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
  confirm?: string;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form
      action={submit}
      onSubmit={(e) => {
        // The one irreversible move gets a question. The rest are a timestamp
        // an admin can correct on the edit screen.
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="contents"
    >
      <input type="hidden" name="event" value={event} />
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

export function LifecycleControls({
  shipment,
  action,
  mayCancel,
}: {
  shipment: Shipment;
  action: Action;
  mayCancel: boolean;
}) {
  const cancelled = shipment.cancelledAt !== null;
  const delivered = shipment.deliveredAt !== null;
  const dispatched = shipment.dispatchedAt !== null;
  const onHold = shipment.status === "on_hold";

  if (cancelled) {
    return (
      <p className="rounded-control bg-ink-100 px-3 py-2 text-small text-ink-600">
        This shipment was cancelled. Nothing further happens to it.
      </p>
    );
  }

  if (delivered) {
    return (
      <p className="rounded-control bg-delivered-bg px-3 py-2 text-small text-delivered">
        Delivered. The record stays as it is.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!dispatched ? (
        <LifecycleButton
          action={action}
          event="dispatch"
          label="Mark dispatched"
          pendingLabel="Saving…"
          variant="primary"
        />
      ) : (
        <LifecycleButton
          action={action}
          event="deliver"
          label="Mark delivered"
          pendingLabel="Saving…"
          variant="primary"
        />
      )}

      {onHold ? (
        <LifecycleButton
          action={action}
          event="resume"
          label="Take off hold"
          pendingLabel="Saving…"
        />
      ) : (
        <LifecycleButton
          action={action}
          event="hold"
          label="Put on hold"
          pendingLabel="Saving…"
        />
      )}

      {mayCancel ? (
        <LifecycleButton
          action={action}
          event="cancel"
          label="Cancel"
          pendingLabel="Cancelling…"
          variant="danger"
          confirm={
            `Cancel ${shipment.reference}? ` +
            "It stays on the record as cancelled and stops being tracked."
          }
        />
      ) : null}
    </div>
  );
}
