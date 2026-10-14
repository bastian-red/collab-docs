/**
 * "4 minutes ago", computed rather than recalled.
 *
 * The clock is a parameter. A default of `Date.now()` would make every test that
 * touches this either sleep or mock the global, and mocking the global is how a
 * test suite starts depending on the order its files run in.
 *
 * `TZ` is read here and only here on the server side. It is declared in
 * `turbo.json` and deliberately absent from `.env.example`: it is the operating
 * system's variable, not this application's, and `scripts/env-contract.mjs`
 * allows exactly that asymmetry because something reads it.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(instant: Date, now: number): string {
  const elapsed = now - instant.getTime();
  if (elapsed < 0) return 'just now';
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 7 * DAY) return plural(Math.floor(elapsed / DAY), 'day');
  return absoluteDay(instant);
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * Past a week, a relative label stops helping: "37 days ago" is a number the
 * reader has to do arithmetic on. The absolute date is pinned to the zone the
 * process runs in, which CI sets to Pacific/Kiritimati on one of its two unit
 * runs precisely to catch a formatter that assumed UTC.
 */
export function absoluteDay(instant: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: serverTimeZone(),
  }).format(instant);
}

export function serverTimeZone(): string {
  const configured = typeof process === 'undefined' ? undefined : process.env.TZ;
  return configured && configured.length > 0 ? configured : 'UTC';
}
