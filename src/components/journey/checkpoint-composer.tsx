"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { GazetteerPlace } from "@/services/checkpoints";
import type { CheckpointKind, JourneyCheckpoint } from "@/types/domain";
import { cn } from "@/lib/utils";

import {
  EMPTY_FORM_STATE,
  type CheckpointFormState,
} from "./checkpoint-form-state";

/**
 * Recording what happened.
 *
 * Two different acts, deliberately kept apart:
 *
 *   CONFIRM — a stage that was planned has now occurred. One click, because
 *   this is what an operator does twenty times a day and any friction here is
 *   friction on the product's core loop.
 *
 *   RECORD — something happened that nobody planned. A breakdown, an
 *   unscheduled depot stop. This needs the full form, and it is the honest way
 *   to represent reality rather than forcing it into a pre-planned stage.
 */

const KINDS: { value: CheckpointKind; label: string }[] = [
  { value: "pickup", label: "Collected" },
  { value: "depot_in", label: "Arrived at depot" },
  { value: "depot_out", label: "Left depot" },
  { value: "linehaul", label: "In transit" },
  { value: "hub_scan", label: "Hub scan" },
  { value: "out_for_delivery", label: "Out for delivery" },
  { value: "delivery", label: "Delivered" },
  { value: "pod", label: "Proof of delivery" },
  { value: "exception", label: "Problem" },
];

const EXCEPTIONS = [
  "delay",
  "breakdown",
  "accident",
  "damage",
  "shortage",
  "refused",
  "rerouted",
  "documentation",
  "weather",
  "other",
];

/** `datetime-local` needs local wall-clock text, not an ISO instant. */
function localNow(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

function StatusLine({ state }: { state: CheckpointFormState }) {
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
        Stage recorded.
      </p>
    );
  }
  return null;
}

export function CheckpointComposer({
  pending,
  places,
  recordAction,
  confirmAction,
  timeZone,
}: {
  /** Stages still awaiting confirmation, nearest first. */
  pending: JourneyCheckpoint[];
  places: GazetteerPlace[];
  recordAction: (
    prev: CheckpointFormState,
    form: FormData
  ) => Promise<CheckpointFormState>;
  confirmAction: (
    prev: CheckpointFormState,
    form: FormData
  ) => Promise<CheckpointFormState>;
  timeZone: string;
}) {
  const [recordState, record, recording] = useActionState(
    recordAction,
    EMPTY_FORM_STATE
  );
  const [confirmState, confirm, confirming] = useActionState(
    confirmAction,
    EMPTY_FORM_STATE
  );

  const [showRecord, setShowRecord] = useState(false);
  const [hasException, setHasException] = useState(false);
  const listId = useId();

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-ink-200 bg-paper p-4 shadow-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lead font-medium text-ink-950">Record progress</h2>
        <p className="text-micro text-ink-400">Times are {timeZone}</p>
      </div>

      {/* The twenty-times-a-day path. */}
      {pending.length > 0 ? (
        <form action={confirm} className="flex flex-col gap-2">
          <Label htmlFor={`${listId}-stage`}>Confirm a planned stage</Label>
          <div className="flex flex-wrap gap-2">
            <select
              id={`${listId}-stage`}
              name="checkpointId"
              className="h-10 min-w-0 flex-1 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
            >
              {pending.map((cp) => (
                <option key={cp.id} value={cp.id}>
                  {cp.label}
                </option>
              ))}
            </select>

            <input
              type="datetime-local"
              name="actualAt"
              defaultValue={localNow()}
              aria-label="When it happened"
              className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
            />

            <Button type="submit" disabled={confirming}>
              {confirming ? "Recording…" : "Mark as done"}
            </Button>
          </div>
          <StatusLine state={confirmState} />
        </form>
      ) : (
        <p className="text-small text-ink-600">
          No planned stages are waiting. Anything that happens now can be
          recorded below.
        </p>
      )}

      <div className="border-t border-ink-100 pt-3">
        <button
          type="button"
          onClick={() => setShowRecord((open) => !open)}
          className="text-small text-marine-700 hover:text-marine-900"
          aria-expanded={showRecord}
        >
          {showRecord ? "Cancel" : "Record something unplanned"}
        </button>

        {showRecord ? (
          <form action={record} className="mt-3 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${listId}-label`}>What happened</Label>
                <Input
                  id={`${listId}-label`}
                  name="label"
                  required
                  placeholder="Roadside stop near Ladysmith"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${listId}-kind`}>Kind</Label>
                <select
                  id={`${listId}-kind`}
                  name="kind"
                  defaultValue="linehaul"
                  className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${listId}-place`}>Where</Label>
                {/* A datalist over the whole gazetteer: no geocoding, and the
                    operator cannot invent a place that has no coordinates. */}
                <select
                  id={`${listId}-place`}
                  name="saPlaceId"
                  defaultValue=""
                  className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
                >
                  <option value="">Not recorded</option>
                  {places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${listId}-actual`}>When</Label>
                <input
                  id={`${listId}-actual`}
                  type="datetime-local"
                  name="actualAt"
                  defaultValue={localNow()}
                  className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-small text-ink-800">
              <input
                type="checkbox"
                checked={hasException}
                onChange={(event) => setHasException(event.target.checked)}
                className="size-4 rounded border-ink-200"
              />
              Something went wrong
            </label>

            {hasException ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <select
                  name="exceptionKind"
                  defaultValue="delay"
                  aria-label="What went wrong"
                  className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950"
                >
                  {EXCEPTIONS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind.charAt(0).toUpperCase() + kind.slice(1)}
                    </option>
                  ))}
                </select>
                <Input name="note" placeholder="What happened, and what next" />
              </div>
            ) : (
              <Input name="note" placeholder="Note (optional)" />
            )}

            <div className={cn("flex gap-2")}>
              <Button type="submit" disabled={recording}>
                {recording ? "Recording…" : "Record stage"}
              </Button>
            </div>

            <StatusLine state={recordState} />
          </form>
        ) : null}
      </div>
    </section>
  );
}
