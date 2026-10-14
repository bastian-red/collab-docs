import { afterEach, describe, expect, it } from 'vitest';

import { absoluteDay, relativeTime, serverTimeZone } from './relative';

const NOW = Date.UTC(2026, 2, 9, 15, 4, 5);
const at = (ms: number) => new Date(NOW - ms);

describe('relativeTime', () => {
  it('collapses anything under a minute to "just now"', () => {
    expect(relativeTime(at(0), NOW)).toBe('just now');
    expect(relativeTime(at(59_999), NOW)).toBe('just now');
  });

  it('singularises exactly one of each unit', () => {
    expect(relativeTime(at(60_000), NOW)).toBe('1 minute ago');
    expect(relativeTime(at(3_600_000), NOW)).toBe('1 hour ago');
    expect(relativeTime(at(86_400_000), NOW)).toBe('1 day ago');
  });

  it('pluralises everything else', () => {
    expect(relativeTime(at(4 * 60_000), NOW)).toBe('4 minutes ago');
    expect(relativeTime(at(3 * 3_600_000), NOW)).toBe('3 hours ago');
    expect(relativeTime(at(3 * 86_400_000), NOW)).toBe('3 days ago');
  });

  it('switches to an absolute date past a week', () => {
    // "37 days ago" is a number the reader has to do arithmetic on.
    expect(relativeTime(at(7 * 86_400_000), NOW)).toBe('2 Mar 2026');
  });

  it('does not render a future instant as a negative age', () => {
    // Two processes disagree about now() by milliseconds, and a clock that
    // stepped backwards would otherwise produce "-1 minutes ago".
    expect(relativeTime(new Date(NOW + 5_000), NOW)).toBe('just now');
  });
});

describe('absoluteDay', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('renders in UTC by default', () => {
    // Computed with `node -e`, not recalled: en-GB with these options gives
    // "9 Mar 2026" with ordinary U+0020 spaces and no narrow no-break space.
    delete process.env.TZ;
    expect(absoluteDay(new Date(NOW))).toBe('9 Mar 2026');
  });

  it('follows TZ, which is the whole reason CI runs the unit lane twice', () => {
    // 15:04 UTC on the 9th is already the 10th in Kiritimati (UTC+14). A
    // formatter that hardcoded UTC would pass the test above and be wrong here,
    // and the second CI unit run sets exactly this zone.
    process.env.TZ = 'Pacific/Kiritimati';
    expect(absoluteDay(new Date(NOW))).toBe('10 Mar 2026');
  });

  it('falls back to UTC rather than to the machine zone when TZ is blank', () => {
    process.env.TZ = '';
    expect(serverTimeZone()).toBe('UTC');
  });
});
