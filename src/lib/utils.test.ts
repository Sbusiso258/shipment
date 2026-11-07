import { describe, expect, it } from "vitest";

import { cn } from "./utils";

/**
 * These exist because of a silent failure, not a hypothetical one.
 *
 * `--text-micro … --text-display` are a custom font-size scale, so `text-body`
 * is a size. tailwind-merge knows only Tailwind's own scale and classified
 * every other `text-*` as a colour — so it read `text-marine-on text-body` as
 * two conflicting colours and dropped the first. Every primary button lost its
 * foreground, which was invisible in the dark theme and a 1.6:1 contrast in
 * the light one.
 */
describe("cn", () => {
  const SIZES = ["micro", "small", "body", "lead", "title", "display"];

  for (const size of SIZES) {
    it(`keeps a colour alongside text-${size}`, () => {
      const result = cn("text-marine-on", `text-${size}`);
      expect(result).toContain("text-marine-on");
      expect(result).toContain(`text-${size}`);
    });
  }

  it("still treats two sizes from the scale as a conflict", () => {
    expect(cn("text-small", "text-body")).toBe("text-body");
  });

  it("still treats two colours as a conflict", () => {
    expect(cn("text-ink-400", "text-ink-950")).toBe("text-ink-950");
  });

  it("still lets a caller override a component default", () => {
    expect(cn("px-4 text-body", "px-2")).toBe("text-body px-2");
  });
});
