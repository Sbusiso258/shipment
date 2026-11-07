import { TZDate } from "@date-fns/tz";
import { differenceInCalendarDays, endOfDay, startOfDay } from "date-fns";

/**
 * Day boundaries in an organisation's own timezone.
 *
 * This file exists because of one bug, and it is the most expensive bug this
 * product could ship.
 *
 * The server runs in UTC. South African operators do not. A delivery promised
 * "Thursday" is late at the end of Thursday *in Johannesburg* — which is
 * 22:00 UTC. Compare a promise-day against a UTC instant instead and every
 * shipment promised today starts reporting as late at 02:00 local, so the
 * board screams at ops every single afternoon until they stop reading it.
 *
 * A false alarm costs more than a missed one. The only thing an oversight
 * product sells is being believed, and a board that cries wolf daily has
 * already lost that.
 *
 * Everything here is pure: the caller passes `now` in. No function below reads
 * the clock, so every rule built on them can be tested over fixed fixtures and
 * re-run "as of last Tuesday" for a report.
 */

/**
 * The last instant of a calendar day, in the given zone.
 *
 * `promisedDeliveryDate` is a `YYYY-MM-DD` string with no time and no offset.
 * This is what turns it into the moment a promise is actually broken.
 */
export function endOfDayIn(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  // Construct the date inside the target zone, then take its end-of-day there.
  const inZone = new TZDate(year, month - 1, date, 12, 0, 0, timeZone);
  return new Date(endOfDay(inZone).getTime());
}

/** The first instant of a calendar day, in the given zone. */
export function startOfDayIn(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const inZone = new TZDate(year, month - 1, date, 12, 0, 0, timeZone);
  return new Date(startOfDay(inZone).getTime());
}

/**
 * Which calendar day an instant falls on, in the given zone, as `YYYY-MM-DD`.
 *
 * Used to answer "was it delivered on the promised day?", which is a question
 * about days and not about elapsed hours.
 */
export function dayIn(instant: Date, timeZone: string): string {
  const inZone = new TZDate(instant.getTime(), timeZone);
  const year = inZone.getFullYear();
  const month = String(inZone.getMonth() + 1).padStart(2, "0");
  const date = String(inZone.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

/**
 * An instant as a `datetime-local` input value — `YYYY-MM-DDTHH:mm` — in the
 * given zone.
 *
 * THIS EXISTS BECAUSE THE EDIT FORM WAS SILENTLY DELETING DATA. The two
 * planned-time fields had their defaults hardcoded to `""`, so the inputs
 * rendered blank but still posted, `readShipment` read them back as null, and
 * saving ANY change to a shipment wiped its planned dispatch and delivery
 * times — the ETA the board shows among them.
 *
 * It had been left blank rather than wrong, which is the right instinct: the
 * stored value is a UTC instant and the input wants the operator's wall
 * clock, and rendering one as the other would show a South African dispatcher
 * a time two hours out. But a blank field on a form that posts is not a
 * missing value, it is a deletion — so the conversion has to be done properly
 * instead of skipped.
 *
 * No seconds: `datetime-local` drops them, and a round-trip through the form
 * would otherwise shift a time by up to a minute on every save.
 */
export function dateTimeLocalIn(instant: Date, timeZone: string): string {
  const inZone = new TZDate(instant.getTime(), timeZone);
  const month = String(inZone.getMonth() + 1).padStart(2, "0");
  const date = String(inZone.getDate()).padStart(2, "0");
  const hours = String(inZone.getHours()).padStart(2, "0");
  const minutes = String(inZone.getMinutes()).padStart(2, "0");
  return `${inZone.getFullYear()}-${month}-${date}T${hours}:${minutes}`;
}

/**
 * Whole calendar days between two instants, in the given zone.
 *
 * Calendar days, not 24-hour periods. "No update in 2 days" means two dates
 * have turned over, which is how a dispatcher counts — not 48 hours, which
 * would make a Monday 09:00 event silent at a different moment than a Monday
 * 17:00 one.
 */
export function calendarDaysBetween(
  earlier: Date,
  later: Date,
  timeZone: string
): number {
  return differenceInCalendarDays(
    new TZDate(later.getTime(), timeZone),
    new TZDate(earlier.getTime(), timeZone)
  );
}

/** Whether `day` (YYYY-MM-DD) is strictly before today, in the given zone. */
export function isBeforeToday(day: string, now: Date, timeZone: string): boolean {
  return day < dayIn(now, timeZone);
}
