import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

/**
 * Formatting for the header clock.
 *
 * Pure, and takes the instant as an argument — so `src/lib` stays clock-free
 * and both functions are testable over fixtures. The ticking lives in
 * `src/hooks/use-now.ts`.
 *
 * Everything here renders in the ORGANISATION's timezone, never the browser's.
 * A dispatcher in Johannesburg and a consignee's broker on a laptop still set
 * to London must read the same wall clock, because the times beside it —
 * planned, actual, promised — are all resolved through that zone too.
 */

/** `Mon, 03 Nov 2025` */
export function formatHeaderDate(instantMs: number, timeZone: string): string {
  return format(new TZDate(instantMs, timeZone), "EEE, dd MMM yyyy");
}

/**
 * `14:32`
 *
 * 24-hour, deliberately. It is what a dispatcher reads off a waybill, and it
 * removes the am/pm ambiguity entirely — the mockup's "14:32 PM" is 24-hour
 * time wearing a meridiem, which is a contradiction.
 */
export function formatHeaderTime(instantMs: number, timeZone: string): string {
  return format(new TZDate(instantMs, timeZone), "HH:mm");
}

/**
 * The zone's short name — `SAST`, `CAT`, `GMT+2`.
 *
 * Derived from the zone rather than hardcoded. `organisations.timezone` is a
 * real column and cross-border is an explicit roadmap item, so an organisation
 * is not necessarily in South Africa.
 *
 * Falls back to the IANA identifier if the runtime gives back something
 * useless, which is better than printing nothing where a zone should be.
 */
export function formatZoneAbbreviation(instantMs: number, timeZone: string): string {
  try {
    // `en-ZA`, explicitly, and not the runtime's default locale.
    //
    // The abbreviation comes from the locale's ICU data, and locales disagree:
    // en-GB and en-US both render Africa/Johannesburg as "GMT+2", while en-ZA
    // gives "SAST". Leaving it to the default means the header says SAST on a
    // South African machine and GMT+2 on a server in Virginia — the same
    // instant, labelled two ways, for no reason the reader can see.
    const parts = new Intl.DateTimeFormat("en-ZA", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date(instantMs));

    return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}
