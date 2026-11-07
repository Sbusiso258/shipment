/**
 * Formatting for the one number an operator reads most: how far off plan a
 * stage ran.
 *
 * Signed, always. "+2h 40m" and "-15m" answer a different question from
 * "2h 40m", and the sign is the whole point — a stage that ran early is not a
 * problem and must not look like one.
 */

/** `+2h 40m`, `-15m`, `+3d 4h`, `on time`. */
export function formatVariance(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes === 0) return "on time";

  const sign = minutes > 0 ? "+" : "−";
  const abs = Math.abs(minutes);

  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  const mins = abs % 60;

  // At most two units. "+3d 4h 12m" is precision nobody acts on, and it makes
  // a dense table harder to scan.
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins && parts.length < 2) parts.push(`${mins}m`);

  return `${sign}${parts.slice(0, 2).join(" ")}`;
}

/** `4 days`, `1 day`. For silence and lateness counts. */
export function formatDays(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * `3 hours ago`, `4 days ago`, `just now`.
 *
 * Takes `now` as an argument. date-fns offers `formatDistanceToNow`, which
 * reads the ambient clock — and using it here produced a real bug: the board
 * rendered "updated in 1 hour" for events that had already happened, because
 * the page's reference time and the machine's wall clock were different.
 *
 * That is the same defect in two disguises. On a server-rendered page the
 * server and the browser compute different strings and React reports a
 * hydration mismatch, intermittently, depending on how long the request took.
 * Hence the rule this file obeys: nothing in `src/lib` reads the clock.
 */
export function formatSince(instant: Date, now: Date): string {
  const seconds = Math.round((now.getTime() - instant.getTime()) / 1000);

  // A future timestamp is a data problem, not something to render as "in 2
  // hours" on a board about things that have already happened.
  if (seconds < 0) return "just now";
  if (seconds < 90) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
