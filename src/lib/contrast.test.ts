import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { contrastRatio, hueDistance, hueOf, parseHex, ratioOf } from "./contrast";

/**
 * Asserts the token file itself, in BOTH themes.
 *
 * The dark ramp was written by hand against a mockup. Without this, the only
 * check on it is somebody looking at a screen and deciding it seems fine —
 * which reliably misses the one failure a dark ramp invites: a colour that
 * reads well beside its neighbours and fails against the surface behind it.
 *
 * Reading the CSS happens here, not in `src/lib/contrast.ts`, because `lib`
 * is pure and does no I/O.
 */

const CSS = readFileSync(
  path.join(import.meta.dirname, "..", "app", "globals.css"),
  "utf8"
);

/** Pulls the `--name: #value;` declarations out of one block. */
function tokensIn(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`No ${selector} block in globals.css`);

  const end = CSS.indexOf("\n}", start);
  const block = CSS.slice(start, end);

  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
    tokens[match[1]] = match[2];
  }
  return tokens;
}

const RAMPS = {
  dark: tokensIn(":root"),
  light: tokensIn(".light"),
};

const STATUSES = ["ontime", "late", "exception", "silent", "delivered"] as const;

describe("contrast maths", () => {
  it("matches the known WCAG extremes", () => {
    expect(contrastRatio(parseHex("#000")!, parseHex("#fff")!)).toBeCloseTo(21, 1);
    expect(contrastRatio(parseHex("#fff")!, parseHex("#fff")!)).toBeCloseTo(1, 5);
  });
});

describe.each(["dark", "light"] as const)("%s ramp", (ramp) => {
  const t = RAMPS[ramp];

  it("defines every token the other ramp defines", () => {
    // A token present in one ramp and missing from the other falls back to
    // the :root value, which in the light theme means a dark colour on a
    // white page — invisible, and only in one theme.
    const other = ramp === "dark" ? RAMPS.light : RAMPS.dark;
    for (const name of Object.keys(other)) {
      expect(t[name], `${ramp} is missing --${name}`).toBeDefined();
    }
  });

  it("puts body text at AA-large or better on both surfaces", () => {
    for (const surface of ["canvas", "paper"] as const) {
      expect(ratioOf(t["ink-950"], t[surface])).toBeGreaterThanOrEqual(7);
      expect(ratioOf(t["ink-800"], t[surface])).toBeGreaterThanOrEqual(7);
      expect(ratioOf(t["ink-600"], t[surface])).toBeGreaterThanOrEqual(4.5);
      // --ink-400 is documented as large text only.
      expect(ratioOf(t["ink-400"], t[surface])).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(STATUSES)("keeps %s readable on the panel surface", (status) => {
    expect(ratioOf(t[`status-${status}`], t["paper"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STATUSES)("keeps %s readable on its own chip", (status) => {
    // The pairing `bg-late-bg text-late` is used directly by verdict-badge
    // and attention-tiles, so the pair has to work as well as the colour.
    expect(
      ratioOf(t[`status-${status}`], t[`status-${status}-bg`])
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the five statuses mutually distinguishable", () => {
    // Never carried by colour alone — every status renders an icon and a word
    // too — but someone scanning a board is reading colour first, and two
    // statuses at the same hue defeat that.
    const hues = STATUSES.map((s) => ({ s, hue: hueOf(t[`status-${s}`]) }));

    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        const distance = hueDistance(hues[i].hue, hues[j].hue);
        expect(
          distance,
          `${hues[i].s} and ${hues[j].s} are only ${Math.round(distance)}° apart`
        ).toBeGreaterThanOrEqual(40);
      }
    }
  });

  it("keeps a primary button's label legible on its fill", () => {
    // The bug this token was created for: buttons used --paper, a SURFACE
    // token, as a foreground. It happened to be white while paper was white.
    expect(ratioOf(t["marine-on"], t["marine-700"])).toBeGreaterThanOrEqual(4.5);
    expect(ratioOf(t["danger-on"], t["danger-fill"])).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps marine-200 legible where it is used as text", () => {
    // Not asserted against --paper: in the light ramp --marine-200 is a pale
    // fill, not a foreground. It is used as text in exactly one place, the
    // owner shell, where it sits on --marine-900.
    expect(ratioOf(t["marine-200"], t["marine-900"])).toBeGreaterThanOrEqual(4.5);
  });
});
