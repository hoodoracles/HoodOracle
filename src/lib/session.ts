// NYSE session classifier.
//
// Everything here works off wall-clock time in America/New_York, derived from a
// UTC instant via Intl rather than a fixed offset, so DST is handled correctly
// without a tz database dependency.

import { Session } from "./types";

/** NYSE full-day closures. Extend as the calendar is published. */
const HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

/** Days the regular session ends at 13:00 ET instead of 16:00. */
const EARLY_CLOSES = new Set<string>([
  "2026-11-27", // day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2027-11-26",
]);

const ET = "America/New_York";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  weekday: "short",
});

export interface EtClock {
  /** YYYY-MM-DD in ET. */
  date: string;
  /** Minutes since ET midnight. */
  minutes: number;
  /** 0 = Sunday .. 6 = Saturday. */
  weekday: number;
  hh: number;
  mm: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Project a UTC instant onto the ET wall clock. */
export function etClock(at: Date): EtClock {
  const parts = PARTS.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const hh = Number(get("hour")) % 24;
  const mm = Number(get("minute"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hh * 60 + mm,
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
    hh,
    mm,
  };
}

const PRE_OPEN = 4 * 60; // 04:00
const REG_OPEN = 9 * 60 + 30; // 09:30
const REG_CLOSE = 16 * 60; // 16:00
const EARLY_CLOSE = 13 * 60; // 13:00
const POST_CLOSE = 20 * 60; // 20:00

export function isHoliday(date: string): boolean {
  return HOLIDAYS.has(date);
}

export function isEarlyClose(date: string): boolean {
  return EARLY_CLOSES.has(date);
}

/** Classify an instant into a trading session. */
export function classifySession(at: Date): Session {
  const c = etClock(at);

  if (c.weekday === 0 || c.weekday === 6) return Session.CLOSED;
  if (isHoliday(c.date)) return Session.HOLIDAY;

  const regClose = isEarlyClose(c.date) ? EARLY_CLOSE : REG_CLOSE;

  if (c.minutes >= PRE_OPEN && c.minutes < REG_OPEN) return Session.PRE;
  if (c.minutes >= REG_OPEN && c.minutes < regClose) return Session.REGULAR;
  if (c.minutes >= regClose && c.minutes < POST_CLOSE) return Session.POST;
  return Session.CLOSED;
}

/** True when trades can actually print. */
export function isTradingSession(s: Session): boolean {
  return s === Session.REGULAR || s === Session.PRE || s === Session.POST;
}

/**
 * Walk forward minute by minute to the next session change.
 * Coarse but exact at minute resolution, and bounded to one week.
 */
export function nextSessionChange(at: Date): {
  nextSession: Session;
  inSeconds: number;
} {
  const current = classifySession(at);
  const startMs = at.getTime();
  const STEP = 60_000;
  const LIMIT = 8 * 24 * 60; // one week of minutes

  for (let i = 1; i <= LIMIT; i++) {
    const probe = new Date(startMs + i * STEP);
    const s = classifySession(probe);
    if (s !== current) {
      // Back off to the exact second boundary of the minute we landed on.
      const c = etClock(probe);
      const secondsIntoMinute = Math.floor((probe.getTime() % 60_000) / 1000);
      void c;
      return {
        nextSession: s,
        inSeconds: Math.max(0, i * 60 - secondsIntoMinute),
      };
    }
  }
  return { nextSession: current, inSeconds: LIMIT * 60 };
}

/**
 * The most recent instant at which a trade could actually have printed.
 *
 * Upstream feeds cannot be trusted to report a real last-trade time: DIA's RWA
 * endpoint stamps some tickers with fetch time rather than print time, so a
 * naive consumer reading HOOD at midnight UTC on a Saturday is handed a
 * timestamp that looks live. We reconcile against the calendar instead: if the
 * tape is shut, the true last print is the close of the last open session,
 * whatever the upstream says.
 */
export function lastTradableInstant(at: Date): Date {
  if (isTradingSession(classifySession(at))) return at;

  const STEP = 60_000;
  const LIMIT = 10 * 24 * 60; // ten days covers any holiday weekend
  for (let i = 1; i <= LIMIT; i++) {
    const probe = new Date(at.getTime() - i * STEP);
    if (isTradingSession(classifySession(probe))) return probe;
  }
  return at;
}

/** Human label for how long the tape has been dark. */
export function describeGap(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}
