/**
 * What was typed, pulled out of a `FormData` so a rejected submission can
 * hand it straight back.
 *
 * WHY THIS IS NEEDED AT ALL. React 19 resets a `<form action={fn}>` once the
 * action settles, and it does that whether the action succeeded or failed.
 * Every form in this application uses uncontrolled inputs with
 * `defaultValue`, so without handing the values back a rejected submission
 * erases everything the person entered and returns one line of red text in
 * exchange. On the shipment form that is fourteen fields.
 *
 * Pure, and therefore here: `FormData` is a plain web type, there is no I/O
 * and no clock.
 */

/** Keyed by field name, because that is what `defaultValue` consumes. */
export type SubmittedValues = Record<string, string>;

/**
 * Every text field of a submission.
 *
 * TWO THINGS ARE DELIBERATELY DROPPED.
 *
 * React's own `$ACTION_*` hidden inputs are machinery — regenerated on every
 * render, meaningless to feed back, and noise in anything that logs this.
 *
 * `File` entries are skipped rather than stringified. A file input cannot be
 * repopulated from a string anyway (browsers forbid setting its value), so
 * carrying `"[object File]"` back would put a lie in the box.
 */
export function submittedValues(form: FormData): SubmittedValues {
  const out: SubmittedValues = {};

  for (const [key, value] of form.entries()) {
    if (key.startsWith("$")) continue;
    if (typeof value !== "string") continue;
    out[key] = value;
  }

  return out;
}
