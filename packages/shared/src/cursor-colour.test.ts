import { describe, expect, it } from 'vitest';

import { CURSOR_RAMP, cursorColour } from './cursor-colour';

/** WCAG 2.1 relative luminance. Kept local: this file is the check on the palette. */
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
}

describe('cursorColour', () => {
  it('gives the same id the same colour every time', () => {
    // The whole point. If this ever fails, a person's caret changes colour
    // between two other people's screens and the hue stops meaning anything.
    const first = cursorColour('cm4x9q2p70000abcd1234efgh');
    for (let i = 0; i < 100; i += 1) {
      expect(cursorColour('cm4x9q2p70000abcd1234efgh')).toBe(first);
    }
  });

  it('is a pure function of the id and nothing else', () => {
    // No clock, no counter, no module-level state. Calling it for other ids in
    // between must not move the answer.
    const before = cursorColour('user-a');
    cursorColour('user-b');
    cursorColour('user-c');
    expect(cursorColour('user-a')).toBe(before);
  });

  it('answers for every string, including the empty one', () => {
    expect(cursorColour('')).toBeDefined();
    expect(cursorColour('áéí')).toBeDefined();
  });

  it('spreads real cuid-shaped ids across the whole ramp', () => {
    // A hash that returns one bucket is deterministic and useless. 200 ids over
    // 8 buckets: every bucket has to be reached.
    const used = new Set<string>();
    for (let i = 0; i < 200; i += 1) used.add(cursorColour(`cm4x9q2p7000${i}abcd1234efgh`).name);
    expect(used.size).toBe(CURSOR_RAMP.length);
  });
});

describe('the ramp itself', () => {
  it('has eight entries with distinct names', () => {
    expect(CURSOR_RAMP).toHaveLength(8);
    expect(new Set(CURSOR_RAMP.map((c) => c.name)).size).toBe(8);
  });

  it('uses no colour twice in either scheme', () => {
    expect(new Set(CURSOR_RAMP.map((c) => c.light)).size).toBe(8);
    expect(new Set(CURSOR_RAMP.map((c) => c.dark)).size).toBe(8);
  });

  it('never reuses the accent or a status colour', () => {
    // A caret in the "synced" green or the "offline" amber is a sentence the
    // interface did not mean to write.
    const reserved = ['#1a6b3c', '#6fca90', '#8a4b00', '#e0a93c', '#a3231c', '#ff9d94'];
    for (const colour of CURSOR_RAMP) {
      expect(reserved).not.toContain(colour.light);
      expect(reserved).not.toContain(colour.dark);
    }
  });

  it('clears 3:1 against its own page as a non-text mark, in both schemes', () => {
    for (const colour of CURSOR_RAMP) {
      expect(ratio(colour.light, '#ffffff'), `${colour.name} light`).toBeGreaterThanOrEqual(3);
      expect(ratio(colour.dark, '#20251f'), `${colour.name} dark`).toBeGreaterThanOrEqual(3);
    }
  });

  it('clears 4.5:1 for the label ink on the hue, in both schemes', () => {
    for (const colour of CURSOR_RAMP) {
      expect(
        ratio(colour.lightInk, colour.light),
        `${colour.name} light ink`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colour.darkInk, colour.dark), `${colour.name} dark ink`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('proves the hues are NOT reliably distinguishable from each other', () => {
    // Inverted on purpose, and the most important assertion in this file.
    // Somewhere in these eight there are two that are the same grey. That fact
    // is what makes the always-rendered name label a requirement rather than a
    // nicety, and if a future palette change made every pair separable, this
    // test failing is the prompt to ask whether the label rule was quietly
    // dropped along with it.
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i < CURSOR_RAMP.length; i += 1) {
      for (let j = i + 1; j < CURSOR_RAMP.length; j += 1) {
        worst = Math.min(worst, ratio(CURSOR_RAMP[i]!.light, CURSOR_RAMP[j]!.light));
      }
    }
    expect(worst).toBeLessThan(1.5);
  });
});
