/**
 * WCAG contrast maths.
 *
 * Pure, like everything in `src/lib` — it takes colours in and gives a number
 * out, and reads no files. The test does the file reading and feeds the token
 * values through these functions.
 *
 * It exists because a dark ramp invites exactly one failure: a colour that
 * looks fine beside its neighbours and fails against the surface it sits on.
 * Eyeballing a status ramp is how that ships.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb` or `#rrggbb`. Returns null for anything else. */
export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");

  if (hex.length === 3) {
    const [r, g, b] = [...hex].map((c) => parseInt(c + c, 16));
    return [r, g, b].every(Number.isFinite) ? { r, g, b } : null;
  }

  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return [r, g, b].every(Number.isFinite) ? { r, g, b } : null;
  }

  return null;
}

/** sRGB channel to linear light. The 0.03928 knee is from the WCAG formula. */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Convenience for the test: hex strings in, ratio out. */
export function ratioOf(foreground: string, background: string): number {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) {
    throw new Error(`Not a hex colour: ${!fg ? foreground : background}`);
  }
  return contrastRatio(fg, bg);
}

/**
 * Hue angle in degrees, for checking that the status colours stay mutually
 * distinguishable rather than drifting together.
 */
export function hueOf(value: string): number {
  const rgb = parseHex(value);
  if (!rgb) throw new Error(`Not a hex colour: ${value}`);

  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (delta === 0) return 0;

  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;

  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/** Shortest distance between two hue angles, 0–180. */
export function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}
