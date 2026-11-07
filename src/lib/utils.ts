import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Class name helper.
 *
 * `clsx` resolves conditionals; `twMerge` then drops Tailwind classes that an
 * earlier argument already set, so a caller's `className` can override a
 * component's default instead of losing to it on specificity.
 *
 * TAILWIND-MERGE MUST BE TOLD ABOUT THE TYPE SCALE, and this was found the
 * hard way. `--text-micro … --text-display` are custom font sizes, so
 * `text-body` is a SIZE — but tailwind-merge ships knowing only Tailwind's own
 * scale (`text-sm`, `text-lg`, …), and classifies any other `text-*` as a
 * COLOUR. It therefore read `text-marine-on text-body` as two colours in
 * conflict and silently dropped the first.
 *
 * The visible result was every primary button losing its foreground: white on
 * blue became inherited near-black on blue, a 1.6:1 contrast in the light
 * theme. Nothing warns about it — the class simply is not in the output — and
 * it was invisible in the dark theme, where inherited body text happens to be
 * pale. Any `cn()` call pairing a colour with a size from this scale was
 * affected.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["micro", "small", "body", "lead", "title", "display"] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
