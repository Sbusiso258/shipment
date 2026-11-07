import { describe, expect, it } from "vitest";

import { dateTimeLocalIn } from "./date";

/**
 * The shipment edit form was DELETING these two fields on every save: their
 * defaults were hardcoded to `""`, so the `datetime-local` inputs rendered
 * blank and posted anyway, `readShipment` read them back as null, and any edit
 * wiped the planned dispatch and delivery times — the board's ETA among them.
 *
 * A round trip through the form must now come back unchanged.
 */
describe("dateTimeLocalIn", () => {
  const ZONE = "Africa/Johannesburg";

  it("renders an instant in the organisation's zone, not UTC", () => {
    // 11:47 UTC is 13:47 in Johannesburg — the ETA the board was showing for
    // N3-0097, and what the form has to put in the box.
    expect(dateTimeLocalIn(new Date("2026-11-26T11:47:00.000Z"), ZONE)).toBe(
      "2026-11-26T13:47"
    );
  });

  it("gives a shape the input accepts, with no seconds", () => {
    // `datetime-local` drops seconds. Emitting them would move the time by up
    // to a minute on every save of an untouched field.
    expect(dateTimeLocalIn(new Date("2026-11-26T11:47:33.500Z"), ZONE)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
    );
  });

  it("pads every part, so the input does not silently reject the value", () => {
    expect(dateTimeLocalIn(new Date("2026-01-02T01:05:00.000Z"), ZONE)).toBe(
      "2026-01-02T03:05"
    );
  });

  // THE REGRESSION TEST THAT MATTERS. What the form shows must parse back to
  // the instant it was given, or saving a field nobody touched moves it.
  it("round-trips through the form without moving the time", () => {
    const original = new Date("2026-11-26T11:47:00.000Z");
    const shown = dateTimeLocalIn(original, ZONE);

    expect(shown).toBe("2026-11-26T13:47");
    // How `instant()` in form-fields.ts reads it back, with the operator's
    // offset applied — SAST is UTC+2 year-round, no daylight saving.
    expect(new Date(`${shown}:00+02:00`).toISOString()).toBe(original.toISOString());
  });

  it("crosses a day boundary in the right direction", () => {
    // 22:30 UTC is already the next day in Johannesburg. Getting this backwards
    // is the two-hour error AGENTS.md warns about, one day out.
    expect(dateTimeLocalIn(new Date("2026-11-26T22:30:00.000Z"), ZONE)).toBe(
      "2026-11-27T00:30"
    );
  });

  it("handles a zone behind UTC too", () => {
    expect(dateTimeLocalIn(new Date("2026-11-26T02:30:00.000Z"), "America/New_York")).toBe(
      "2026-11-25T21:30"
    );
  });
});
