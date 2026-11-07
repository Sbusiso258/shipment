"use client";

import { useActionState } from "react";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  EMPTY_PANEL_STATE,
  type PanelFormState,
} from "./panel-form-state";

/**
 * The one composer at the foot of the panel, doing a different job per tab.
 *
 * When the viewer's role cannot perform the action it renders a sentence
 * instead of a form. Offering somebody a box that always fails is a lie, and
 * it is a lie they only discover after typing.
 */
export function PanelComposer({
  action,
  placeholder,
  disabledReason,
  hidden,
}: {
  action: (prev: PanelFormState, form: FormData) => Promise<PanelFormState>;
  placeholder: string;
  /** Set when the signed-in role cannot do this. */
  disabledReason?: string | null;
  /** Extra fields the action needs, rendered as hidden inputs. */
  hidden?: Record<string, string>;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_PANEL_STATE);

  if (disabledReason) {
    return (
      <p className="shrink-0 border-t border-ink-200 px-3 py-3 text-small text-ink-400">
        {disabledReason}
      </p>
    );
  }

  return (
    <form action={submit} className="shrink-0 border-t border-ink-200 p-3">
      <div className="flex gap-2">
        {Object.entries(hidden ?? {}).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}

        <Input
          name="body"
          required
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-paper-raised"
          // Cleared by the re-render that follows a successful submit.
          key={state.ok ? "sent" : "composing"}
        />

        <Button type="submit" disabled={pending} aria-label="Send">
          <Send aria-hidden className="size-4" />
          <span className={cn("hidden sm:inline")}>
            {pending ? "Sending…" : "Send"}
          </span>
        </Button>
      </div>

      {state.error ? (
        <p role="alert" className="mt-2 text-small text-exception">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
