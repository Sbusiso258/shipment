import { describe, expect, it } from "vitest";

import { formatDays, formatSince, formatVariance } from "./duration";

describe("formatVariance", () => {
  it("signs lateness positive and earliness negative", () => {
    expect(formatVariance(160)).toBe("+2h 40m");
    expect(formatVariance(-15)).toBe("−15m");
  });

  it("says 'on time' rather than '+0m'", () => {
    expect(formatVariance(0)).toBe("on time");
  });

  it("is null when there is nothing to compare", () => {
    expect(formatVariance(null)).toBeNull();
  });

  it("stops at two units", () => {
    // +3d 4h 12m is precision nobody acts on and it makes a table harder to
    // scan.
    expect(formatVariance(3 * 1440 + 4 * 60 + 12)).toBe("+3d 4h");
  });

  it("handles whole hours and whole days", () => {
    expect(formatVariance(120)).toBe("+2h");
    expect(formatVariance(1440)).toBe("+1d");
  });
});

describe("formatDays", () => {
  it("singularises one day", () => {
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(4)).toBe("4 days");
  });
});

describe("formatSince", () => {
  const now = new Date("2026-11-03T13:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("measures against the supplied now, not the wall clock", () => {
    // The bug this function exists to fix: date-fns' formatDistanceToNow
    // reads the ambient clock, so a page with a fixed reference time rendered
    // "in 1 hour" for events that had already happened.
    expect(formatSince(ago(3 * 3_600_000), now)).toBe("3 hours ago");
  });

  it("scales from minutes to hours to days", () => {
    expect(formatSince(ago(20 * 60_000), now)).toBe("20 min ago");
    expect(formatSince(ago(2 * 3_600_000), now)).toBe("2 hours ago");
    expect(formatSince(ago(1 * 3_600_000), now)).toBe("1 hour ago");
    expect(formatSince(ago(4 * 86_400_000), now)).toBe("4 days ago");
  });

  it("stays in hours past the 24-hour mark", () => {
    // Deliberate: for an operations board "25 hours ago" is more use than
    // "1 day ago", which rounds away the difference between this morning and
    // yesterday morning. Days take over at 36 hours.
    expect(formatSince(ago(25 * 3_600_000), now)).toBe("25 hours ago");
    expect(formatSince(ago(40 * 3_600_000), now)).toBe("2 days ago");
  });

  it("says 'just now' rather than counting seconds", () => {
    expect(formatSince(ago(30_000), now)).toBe("just now");
  });

  it("never renders a future timestamp as 'in 2 hours'", () => {
    // A future lastEventAt is a data problem. This is a board about things
    // that have already happened, so it must not read like a forecast.
    expect(formatSince(new Date(now.getTime() + 2 * 3_600_000), now)).toBe(
      "just now"
    );
  });
});
