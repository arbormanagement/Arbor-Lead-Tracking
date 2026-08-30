/**
 * Office-hours computation for Chloe's inbound Retell webhook.
 *
 * Ported verbatim from Arbor-Automations `server/officeHours.ts` (2026-08-30,
 * the merge's slice 1). The sentences below are injected into Chloe's prompt as
 * {{office_status}} / {{office_next_open}} and simulation test cases are built
 * by RUNNING this module — treat any wording change as a prompt change needing
 * a graded simulation batch, not a refactor.
 *
 * This module exists so the VOICE MODEL never has to derive whether the office
 * is open. Chloe's prompt previously made that decision in seven separate
 * sections by comparing the injected current time against a list of hours and
 * holidays; the floating holidays (Memorial Day, Labor Day, Thanksgiving) in
 * particular are dates the model has to reason out, and the transfer gate
 * failed repeatedly as a result. Everything here is pure local computation
 * with no network calls, so it cannot fail on a timeout.
 *
 * Hours: Monday-Friday, 7:00am-5:00pm America/Chicago, excluding the holidays
 * below. Emergencies are handled 24/7 and are gated in the prompt, not here.
 */

export const TIME_ZONE = "America/Chicago";

const OPEN_HOUR = 7;
const CLOSE_HOUR = 17;

/** Wall-clock date/time in America/Chicago, independent of server locale. */
interface ZonedNow {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function toZoned(date: Date, timeZone = TIME_ZONE): ZonedNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // Intl renders midnight as hour 24 in some ICU versions; normalize to 0.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** Nth given weekday of a month, e.g. nthWeekdayOfMonth(2026, 11, 4, 4) = 4th Thursday of November. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** Last given weekday of a month, e.g. Memorial Day = last Monday of May. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastWeekdayIdx = new Date(Date.UTC(year, month - 1, daysInMonth)).getUTCDay();
  return daysInMonth - ((lastWeekdayIdx - weekday + 7) % 7);
}

/**
 * Company closures. The three federal fixed-date holidays shift under the
 * federal observance rule; the two "Eve" closures are company-specific, have
 * no federal observance, and stay on their actual date.
 */
interface FixedHoliday {
  month: number;
  day: number;
  name: string;
  /** Federal holidays shift off a weekend; company closures do not. */
  federal: boolean;
}

const FIXED_HOLIDAYS: FixedHoliday[] = [
  { month: 7, day: 4, name: "the 4th of July", federal: true },
];

/**
 * The winter closure. The office is closed CONTINUOUSLY from December 24th
 * through January 1st inclusive — not on the individual holidays within it
 * (Justin, 2026-08-27). That is nine calendar days and it spans the year
 * boundary, so it is handled as a range rather than as dated entries.
 *
 * Because the whole block is closed regardless of which weekdays the dates
 * land on, federal observance is irrelevant inside it, with one exception:
 * if January 1st falls on a Sunday, the federal observance is Monday the 2nd,
 * which sits just outside the block and is therefore added.
 */
const WINTER_CLOSURE_NAME = "our holiday closure";

function isWinterClosure(z: { year: number; month: number; day: number }): boolean {
  if (z.month === 12 && z.day >= 24) return true;
  if (z.month === 1 && z.day === 1) return true;
  if (z.month === 1 && z.day === 2) {
    // January 1st on a Sunday is federally observed the following Monday.
    return new Date(Date.UTC(z.year, 0, 1)).getUTCDay() === 0;
  }
  return false;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Federal observance: a holiday landing on Saturday is observed the preceding
 * Friday, one landing on Sunday the following Monday (Justin, 2026-08-27).
 *
 * A company closure that lands on a weekend needs no shift — the office is
 * already closed Saturday and Sunday — so those are returned untouched.
 *
 * Note the Saturday rule can move New Year's Day backward across the year
 * boundary into December 31st of the prior year.
 */
function observedDate(year: number, month: number, day: number, federal: boolean): CalendarDate {
  const actual = new Date(Date.UTC(year, month - 1, day));
  const weekday = actual.getUTCDay();
  if (!federal || (weekday !== 0 && weekday !== 6)) {
    return { year, month, day };
  }

  const shift = weekday === 6 ? -1 : 1; // Saturday back to Friday, Sunday forward to Monday
  const observed = new Date(Date.UTC(year, month - 1, day + shift));
  return {
    year: observed.getUTCFullYear(),
    month: observed.getUTCMonth() + 1,
    day: observed.getUTCDate(),
  };
}

function dateKey(month: number, day: number): string {
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The SINGLE-DAY closures in the given year, as "MM-DD" -> name. The winter
 * block (Dec 24 - Jan 1) is not in here; use isWinterClosure or holidayName,
 * both of which account for it.
 *
 * Neighbouring years are still scanned because federal observance can move a
 * holiday across the year boundary.
 */
export function holidaysForYear(year: number): Map<string, string> {
  const holidays = new Map<string, string>();

  for (const sourceYear of [year - 1, year, year + 1]) {
    for (const holiday of FIXED_HOLIDAYS) {
      const observed = observedDate(sourceYear, holiday.month, holiday.day, holiday.federal);
      if (observed.year !== year) continue;
      const key = dateKey(observed.month, observed.day);
      // The holiday native to this date keeps its name over one shifted onto it.
      if (!holidays.has(key)) holidays.set(key, holiday.name);
    }
  }

  // These three are defined by weekday, so they never land on a weekend and
  // never need an observance shift.
  holidays.set(dateKey(5, lastWeekdayOfMonth(year, 5, 1)), "Memorial Day");
  holidays.set(dateKey(9, nthWeekdayOfMonth(year, 9, 1, 1)), "Labor Day");
  holidays.set(dateKey(11, nthWeekdayOfMonth(year, 11, 4, 4)), "Thanksgiving");

  return holidays;
}

export function holidayName(z: ZonedNow): string | null {
  if (isWinterClosure(z)) return WINTER_CLOSURE_NAME;
  return holidaysForYear(z.year).get(dateKey(z.month, z.day)) ?? null;
}

function isBusinessDay(z: ZonedNow): boolean {
  if (z.weekday === 0 || z.weekday === 6) return false;
  return holidayName(z) === null;
}

/** Advance a zoned date by one calendar day, keeping the zone's wall clock. */
function nextDay(z: ZonedNow): ZonedNow {
  const d = new Date(Date.UTC(z.year, z.month - 1, z.day + 1, 12));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: z.hour,
    minute: z.minute,
    weekday: d.getUTCDay(),
  };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface OfficeStatus {
  /** True when the scheduling team is actually reachable right now. */
  open: boolean;
  /** Full directive sentence injected as {{office_status}}. */
  statusSentence: string;
  /** Full sentence injected as {{office_next_open}}. */
  nextOpenSentence: string;
  /** Holiday name if today is one, else "". Useful for logging. */
  holiday: string;
}

/**
 * The values Chloe actually receives. Both sentences are written as
 * INSTRUCTIONS, not data: Retell rejects non-string dynamic variables, and a
 * bare "CLOSED" leaves the model to decide what closed implies. Telling it
 * what to do removes that step.
 */
export function computeOfficeStatus(now: Date = new Date()): OfficeStatus {
  const z = toZoned(now);
  const holiday = holidayName(z);
  const withinHours = z.hour >= OPEN_HOUR && z.hour < CLOSE_HOUR;
  const open = isBusinessDay(z) && withinHours;

  const nextOpenSentence = describeNextOpen(z);

  // The closed sentence names the emergency exception explicitly. Emergencies
  // are handled 24/7/365 including the whole winter closure (Justin,
  // 2026-08-27), and this line is the most prominent availability statement
  // Chloe sees — if it read as a flat "nobody is available" she could take a
  // message on a call where a tree is on someone's house.
  const statusSentence = open
    ? "The scheduling team IS available right now. You are permitted to transfer this call."
    : `The scheduling team is NOT available right now${holiday ? ` (${holiday})` : ""}. ` +
      "For NON-emergency calls, do not run warm_office_transfer — take a message instead. " +
      "EMERGENCY calls are handled 24 hours a day, every day of the year, including holidays: " +
      "transfer those exactly as the ##Emergency section directs, no matter what this line says. " +
      nextOpenSentence;

  return { open, statusSentence, nextOpenSentence, holiday: holiday ?? "" };
}

function describeNextOpen(z: ZonedNow): string {
  // Still before opening on a business day: the team is back the same morning.
  if (isBusinessDay(z) && z.hour < OPEN_HOUR) {
    return "The team is back at 7 this morning.";
  }

  let cursor = nextDay(z);
  let daysAhead = 1;
  // The winter closure plus surrounding weekends can run past ten days, so the
  // horizon is deliberately wider than any single gap it needs to cross.
  while (!isBusinessDay(cursor) && daysAhead < 21) {
    cursor = nextDay(cursor);
    daysAhead += 1;
  }

  if (daysAhead === 1) return "The team is back at 7 tomorrow morning.";
  if (daysAhead <= 6) return `The team is back at 7 in the morning on ${DAY_NAMES[cursor.weekday]}.`;

  // Beyond a week away, a bare weekday name reads as "in a few days" and
  // misleads a caller sitting in the middle of the holiday closure.
  const date = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day));
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
  }).format(date);
  return `The team is back at 7 in the morning on ${label}.`;
}

/**
 * Fail-safe used when anything upstream throws, and the behaviour the prompt
 * should fall back to if this webhook is unreachable and {{office_status}}
 * arrives blank.
 *
 * It reports the team as UNAVAILABLE. That is the opposite of what it was
 * built as, and the reason is Justin's 2026-08-27 correction: the office line
 * IS answered after hours by on-call staff. So a wrong "available" outside
 * hours does not cost dead air — it rings a real person at 3am for a
 * non-emergency, which is precisely the behaviour this webhook exists to stop.
 *
 * The cost the other way is smaller than it looks. Emergencies transfer
 * regardless of this value, so they are unaffected. And on the estimate path
 * create_estimate runs on BOTH branches, so a wrongly-closed call still
 * captures the lead and still gets a callback — what is lost is the live
 * handoff, not the customer.
 *
 * The regression to accept knowingly: during an outage in business hours,
 * ##Speak to Human and ##General Questions would take a message rather than
 * transfer immediately, which is the behaviour v97/v98 were written to stop.
 * That is bounded by the length of the outage and is recoverable by a callback;
 * waking on-call is neither.
 */
export const FAIL_SAFE_STATUS: OfficeStatus = {
  open: false,
  statusSentence:
    "The scheduling team's availability could not be confirmed, so treat them as NOT available. " +
    "For NON-emergency calls, do not run warm_office_transfer — take a message instead. " +
    "EMERGENCY calls are handled 24 hours a day, every day of the year, including holidays: " +
    "transfer those exactly as the ##Emergency section directs, no matter what this line says.",
  nextOpenSentence: "The team is back at 7 in the morning on the next business day.",
  holiday: "",
};
