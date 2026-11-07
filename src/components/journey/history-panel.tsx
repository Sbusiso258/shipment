import { History } from "lucide-react";

import {
  changedFields,
  describeAction,
  describeActor,
  isCorrection,
} from "@/lib/history";
import type { DecisionLogEntry } from "@/types/domain";

/**
 * What was decided about this load, and by whom.
 *
 * A SERVER COMPONENT with no state. There is nothing to interact with: the
 * trail cannot be edited, filtered down to something flattering, or added to
 * from here, and giving it controls would imply otherwise.
 *
 * Every judgement in here comes from `src/lib/history.ts` so it can be tested
 * over fixtures; this file places text.
 */
export function HistoryPanel({
  entries,
  actorNames,
  viewerId,
  notice,
  timeZone,
}: {
  entries: DecisionLogEntry[];
  /** userId → name, for whoever the viewer is allowed to see. */
  actorNames: Readonly<Record<string, string>>;
  viewerId: string;
  /** Set when the database is behind and the trail could not be read. */
  notice: string | null;
  timeZone: string;
}) {
  const stamp = new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });

  return (
    <section className="rounded-panel border border-ink-200 bg-paper-raised p-panel shadow-panel">
      <header className="mb-3 flex items-center gap-2">
        <History className="size-4 text-ink-500" aria-hidden />
        <h2 className="text-small font-medium text-ink-950">History</h2>
      </header>

      {notice ? (
        <p
          role="status"
          className="rounded-control bg-late-bg px-3 py-2 text-small text-late"
        >
          {notice}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-small text-ink-500">
          Nothing recorded against this load yet. Every change from here on
          writes a line here automatically.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {entries.map((entry) => {
            const fields = changedFields(entry);
            return (
              <li
                key={entry.id}
                className="border-l-2 border-ink-200 pl-3 data-[correction=true]:border-late"
                data-correction={isCorrection(entry.action)}
              >
                <p className="text-small text-ink-950">
                  {describeAction(entry.action)}
                </p>
                <p className="text-micro text-ink-500">
                  {describeActor(entry.actorId, actorNames, viewerId)}
                  {" · "}
                  {/* The organisation's zone, not the server's. A trail
                      stamped in UTC is a trail nobody can cross-check against
                      what they remember doing. */}
                  <time dateTime={entry.createdAt}>
                    {stamp.format(new Date(entry.createdAt))}
                  </time>
                </p>

                {entry.reason ? (
                  <p className="mt-1 text-micro text-ink-600">{entry.reason}</p>
                ) : null}

                {fields.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {fields.map((field) => (
                      <li key={field.field} className="text-micro text-ink-600">
                        <span className="text-ink-500">{field.field}</span>
                        {field.from === "" && field.to === "" ? (
                          " changed"
                        ) : (
                          <>
                            {": "}
                            <span className="font-code">{field.from}</span>
                            {" → "}
                            <span className="font-code">{field.to}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
