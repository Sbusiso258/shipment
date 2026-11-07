"use client";

import { useActionState } from "react";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Task, TaskPriority } from "@/types/domain";

import {
  EMPTY_PANEL_STATE,
  type PanelFormState,
} from "./panel-form-state";

const PRIORITY: Record<TaskPriority, { label: string; tone: string }> = {
  urgent: { label: "Urgent", tone: "text-exception" },
  high: { label: "High", tone: "text-late" },
  normal: { label: "", tone: "" },
  low: { label: "Low", tone: "text-ink-400" },
};

function CompleteButton({
  task,
  action,
}: {
  task: Task;
  action: (prev: PanelFormState, form: FormData) => Promise<PanelFormState>;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_PANEL_STATE);
  const done = task.status === "done";

  return (
    <form action={submit}>
      <input type="hidden" name="taskId" value={task.id} />
      {/* Toggles rather than only completing: a task ticked by mistake has to
          be recoverable, and the trigger clears the completion stamp when the
          status moves off done. */}
      <input type="hidden" name="status" value={done ? "open" : "done"} />

      <button
        type="submit"
        disabled={pending}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        className={cn(
          "flex size-5 items-center justify-center rounded-[0.25rem] border transition-colors",
          done
            ? "border-ontime bg-ontime text-canvas"
            : "border-ink-400 hover:border-ontime"
        )}
      >
        {done ? <Check aria-hidden className="size-3.5" /> : null}
      </button>

      {state.error ? (
        <span role="alert" className="sr-only">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

export function TasksTab({
  tasks,
  timeZone,
  onToggle,
}: {
  tasks: Task[];
  timeZone: string;
  onToggle: (prev: PanelFormState, form: FormData) => Promise<PanelFormState>;
}) {
  if (tasks.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-small text-ink-400">
        Nothing assigned. Tasks created here can be attached to a shipment and
        handed to an operator.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-list">
      {tasks.map((task) => {
        const done = task.status === "done";
        const priority = PRIORITY[task.priority];

        return (
          <li
            key={task.id}
            className="flex gap-3 rounded-panel border border-ink-200 bg-paper-raised p-3"
          >
            <div className="pt-0.5">
              <CompleteButton task={task} action={onToggle} />
            </div>

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-small",
                  done ? "text-ink-400 line-through" : "text-ink-950"
                )}
              >
                {task.title}
              </p>

              <p className="mt-0.5 flex flex-wrap gap-x-2 text-micro text-ink-400">
                {task.shipmentReference ? (
                  <span className="font-code">{task.shipmentReference}</span>
                ) : null}
                {task.dueAt ? (
                  <span>
                    Due{" "}
                    {format(
                      new TZDate(new Date(task.dueAt).getTime(), timeZone),
                      "EEE d MMM"
                    )}
                  </span>
                ) : null}
                {priority.label ? (
                  <span className={priority.tone}>{priority.label}</span>
                ) : null}
                {task.status === "blocked" ? (
                  <span className="text-late">Blocked</span>
                ) : null}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
