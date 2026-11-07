"use client";

import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

import type { CheckpointState } from "@/lib/journey";
import { formatVariance } from "@/lib/duration";
import { variance } from "@/lib/journey";
import { cn } from "@/lib/utils";
import type { JourneyCheckpoint } from "@/types/domain";

/**
 * The journey, as an ordered rail.
 *
 * Reading rules, in priority order:
 *   - an exception is loud and its note is ALWAYS expanded
 *   - the current position is the only animated thing on the page
 *   - a skipped stage is struck through, never hidden
 *   - planned and actual sit side by side wherever both exist, so slippage is
 *     read rather than calculated
 */

const STATE_STYLES: Record<
  CheckpointState,
  { dot: string; rail: string; label: string }
> = {
  cleared: { dot: "bg-ontime", rail: "bg-ontime/30", label: "text-ink-800" },
  current: { dot: "bg-marine-700", rail: "bg-ink-200", label: "text-ink-950 font-medium" },
  pending: { dot: "bg-ink-200", rail: "bg-ink-200", label: "text-ink-400" },
  overdue: { dot: "bg-late", rail: "bg-ink-200", label: "text-late font-medium" },
  skipped: { dot: "bg-ink-200", rail: "bg-ink-200", label: "text-ink-400 line-through" },
  exception: { dot: "bg-exception", rail: "bg-exception/30", label: "text-exception font-medium" },
};

const STATE_WORD: Record<CheckpointState, string> = {
  cleared: "Done",
  current: "Here now",
  pending: "Pending",
  overdue: "Overdue",
  skipped: "Not scanned",
  exception: "Problem",
};

function when(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  return format(new TZDate(new Date(iso).getTime(), timeZone), "EEE d MMM HH:mm");
}

export function CheckpointSpine({
  checkpoints,
  states,
  selectedId,
  onSelect,
  timeZone,
}: {
  checkpoints: JourneyCheckpoint[];
  states: Map<string, CheckpointState>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  timeZone: string;
}) {
  if (checkpoints.length === 0) {
    return (
      <div className="rounded-panel border border-dashed border-ink-200 p-6 text-center">
        <p className="text-ink-600">No checkpoints logged yet.</p>
        <p className="mt-1 text-small text-ink-400">
          The journey appears here as stages are recorded.
        </p>
      </div>
    );
  }

  const ordered = [...checkpoints].sort((a, b) => a.sequenceNo - b.sequenceNo);

  return (
    <ol className="flex flex-col">
      {ordered.map((cp, index) => {
        const state = states.get(cp.id) ?? "pending";
        const style = STATE_STYLES[state];
        const isSelected = cp.id === selectedId;
        const isLast = index === ordered.length - 1;

        const planned = when(cp.plannedAt, timeZone);
        const actual = when(cp.actualAt, timeZone);
        const drift = formatVariance(variance(cp.plannedAt, cp.actualAt));

        return (
          <li key={cp.id} className="flex gap-3">
            {/* The rail. The dot marks the stage; the line joins it to the next. */}
            <div className="flex flex-col items-center pt-1.5" aria-hidden>
              <span className="relative flex size-3 items-center justify-center">
                {state === "current" ? (
                  <span className="absolute inline-flex size-3 animate-ping rounded-full bg-marine-500 opacity-60" />
                ) : null}
                <span className={cn("size-3 rounded-full", style.dot)} />
              </span>
              {!isLast ? <span className={cn("w-px flex-1", style.rail)} /> : null}
            </div>

            <button
              type="button"
              onClick={() => onSelect(cp.id)}
              aria-current={isSelected ? "step" : undefined}
              className={cn(
                "mb-1 flex-1 rounded-control px-3 py-2 text-left transition-colors",
                "hover:bg-ink-100",
                isSelected && "bg-ink-100",
                state === "exception" && "border-l-2 border-exception"
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className={cn("text-body", style.label)}>{cp.label}</span>
                <span
                  className={cn(
                    "font-code text-micro uppercase tracking-wide",
                    state === "overdue" || state === "exception"
                      ? style.label
                      : "text-ink-400"
                  )}
                >
                  {STATE_WORD[state]}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 font-code text-micro">
                {planned ? (
                  <span className={state === "overdue" ? "text-late" : "text-ink-400"}>
                    Planned {planned}
                  </span>
                ) : (
                  // Never a back-filled estimate. A stage with no planned time
                  // has no planned time.
                  <span className="text-ink-400">No planned time</span>
                )}

                {actual ? (
                  <span className="text-ink-800">Actual {actual}</span>
                ) : null}

                {drift ? (
                  <span
                    className={cn(
                      (variance(cp.plannedAt, cp.actualAt) ?? 0) > 0
                        ? "text-late"
                        : "text-ontime"
                    )}
                  >
                    {drift}
                  </span>
                ) : null}
              </div>

              {cp.placeName ? (
                <p className="mt-0.5 text-micro text-ink-400">{cp.placeName}</p>
              ) : null}

              {/* An exception the operator must click to read is an exception
                  nobody reads. */}
              {cp.exceptionKind ? (
                <p className="mt-2 rounded-control bg-exception-bg px-2 py-1.5 text-small text-exception">
                  <span className="font-medium capitalize">
                    {cp.exceptionKind.replace(/_/g, " ")}
                  </span>
                  {cp.note ? <> — {cp.note}</> : null}
                </p>
              ) : cp.note ? (
                <p className="mt-1 text-small text-ink-600">{cp.note}</p>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
