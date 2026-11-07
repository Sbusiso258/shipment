import { describe, expect, it } from "vitest";

import {
  formatHeaderDate,
  formatHeaderTime,
  formatZoneAbbreviation,
} from "./clock";

// 13:00 UTC = 15:00 in Johannesburg, on a Monday.
const INSTANT = new Date("2026-11-03T13:00:00Z").getTime();
const SAST = "Africa/Johannesburg";

describe("formatHeaderTime", () => {
  it("renders the organisation's wall clock, not UTC", () => {
    expect(formatHeaderTime(INSTANT, SAST)).toBe("15:00");
    expect(formatHeaderTime(INSTANT, "UTC")).toBe("13:00");
  });

  it("is 24-hour", () => {
    // The mockup's "14:32 PM" is 24-hour time wearing a meridiem. A waybill
    // says 15:00, so the header does too.
    expect(formatHeaderTime(INSTANT, SAST)).not.toMatch(/[ap]m/i);
  });

  it("renders a different organisation's zone correctly", () => {
    // Cross-border is on the roadmap, so this must not be hardcoded to SAST.
    expect(formatHeaderTime(INSTANT, "Europe/London")).toBe("13:00");
  });
});

describe("formatHeaderDate", () => {
  it("renders the day in the organisation's zone", () => {
    expect(formatHeaderDate(INSTANT, SAST)).toBe("Tue, 03 Nov 2026");
  });

  it("can disagree with UTC about which day it is", () => {
    // 23:30 SAST on the 3rd is 21:30 UTC the same day; an hour later they
    // part company. This is the whole reason the zone is passed in.
    const lateEvening = new Date("2026-11-03T23:30:00Z").getTime();
    expect(formatHeaderDate(lateEvening, SAST)).toBe("Wed, 04 Nov 2026");
    expect(formatHeaderDate(lateEvening, "UTC")).toBe("Tue, 03 Nov 2026");
  });
});

describe("formatZoneAbbreviation", () => {
  it("derives the abbreviation from the zone", () => {
    expect(formatZoneAbbreviation(INSTANT, SAST)).toBe("SAST");
  });

  it("gives a different answer for a different zone", () => {
    expect(formatZoneAbbreviation(INSTANT, SAST)).not.toBe(
      formatZoneAbbreviation(INSTANT, "Europe/London")
    );
  });

  it("falls back to the identifier rather than printing nothing", () => {
    expect(formatZoneAbbreviation(INSTANT, "Not/AZone")).toBe("Not/AZone");
  });
});
