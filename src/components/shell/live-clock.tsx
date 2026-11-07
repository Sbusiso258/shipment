"use client";

import { useNow } from "@/hooks/use-now";
import {
  formatHeaderDate,
  formatHeaderTime,
  formatZoneAbbreviation,
} from "@/lib/clock";
import { cn } from "@/lib/utils";

/**
 * The header clock.
 *
 * `serverNowMs` is the instant the page captured when it rendered. It is the
 * value SSR paints AND the value hydration paints, so the two agree exactly;
 * only afterwards does the live time take over. That is the whole trick, and
 * it is why this is safe in a codebase that otherwise forbids reading the
 * clock on the client.
 *
 * Rendered in the organisation's zone, never the browser's — the times beside
 * it on the board are all resolved through that zone, and a header that
 * disagreed with them would be worse than no header.
 */
export function LiveClock({
  serverNowMs,
  timeZone,
  className,
}: {
  serverNowMs: number;
  timeZone: string;
  className?: string;
}) {
  const now = useNow(serverNowMs);

  return (
    <div className={cn("flex flex-col leading-tight", className)}>
      <span className="font-code text-small text-ink-950">
        {formatHeaderTime(now, timeZone)}
        <span className="ml-1.5 text-ink-400">
          {formatZoneAbbreviation(now, timeZone)}
        </span>
      </span>
      <span className="text-micro text-ink-400">
        {formatHeaderDate(now, timeZone)}
      </span>
    </div>
  );
}
