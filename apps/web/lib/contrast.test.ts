/**
 * Every colour pair this app paints, against WCAG AA, in both schemes, parsed
 * from the real `app/globals.css` (docs/DESIGN.md 2.2).
 *
 * The numbers are derived from the stylesheet, never from a copy of the palette:
 * a table of hexes in TypeScript would pass forever while the CSS said something
 * else, and the only symptom would be somebody unable to read the page.
 *
 * The second half is the part specific to this product: the four sync colours are
 * USELESS against each other, and that is asserted rather than assumed. It is the
 * evidence that the glyph and the word on the pill are load-bearing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CURSOR_RAMP } from '@docs/shared';
import { describe, expect, it } from 'vitest';

import {
  AA_NORMAL,
  AA_UI,
  composite,
  extractTokens,
  greyscale,
  ratio,
  resolve,
  stripCssComments,
} from './contrast';

const globals = stripCssComments(readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8'));

/** The dark block overrides a subset, so it is layered over the light one. */
const light = extractTokens(globals, ':root');
const dark = { ...light, ...extractTokens(globals, '@media (prefers-color-scheme: dark)') };

const SCHEMES = [
  ['light', light],
  ['dark', dark],
] as const;

const SURFACES = ['--bg', '--surface', '--surface-2'] as const;

/** Text colours that appear on any of the three surfaces. */
const TEXT_ON_SURFACES = ['--text', '--muted', '--accent', '--warn', '--danger'] as const;

/** Pairs that only ever meet each other. */
const TEXT_PAIRS = [
  ['--accent-ink', '--accent'],
  ['--text', '--accent-soft'],
  ['--accent', '--accent-soft'],
  // .button-danger: page-coloured text on the red.
  ['--surface', '--danger'],
] as const;

describe('text clears AA on every surface, in both schemes', () => {
  for (const [scheme, palette] of SCHEMES) {
    for (const foreground of TEXT_ON_SURFACES) {
      for (const background of SURFACES) {
        it(`${scheme}: ${foreground} on ${background}`, () => {
          const value = ratio(resolve(palette, foreground), resolve(palette, background));
          expect(
            value,
            `${scheme} ${foreground} on ${background} is ${value}:1`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
    for (const [foreground, background] of TEXT_PAIRS) {
      it(`${scheme}: ${foreground} on ${background}`, () => {
        const value = ratio(resolve(palette, foreground), resolve(palette, background));
        expect(
          value,
          `${scheme} ${foreground} on ${background} is ${value}:1`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }
});

describe('control edges and the focus ring clear 3:1 on every surface', () => {
  for (const [scheme, palette] of SCHEMES) {
    for (const edge of ['--border', '--accent'] as const) {
      for (const background of SURFACES) {
        it(`${scheme}: ${edge} on ${background}`, () => {
          expect(
            ratio(resolve(palette, edge), resolve(palette, background)),
          ).toBeGreaterThanOrEqual(AA_UI);
        });
      }
    }
  }

  it('records the weakest edge, so a change to the dark surfaces is noticed', () => {
    // DESIGN.md 2.2 names this as the first pair to recheck: dark --border on
    // --surface-2. Pinned to its measured value so a drift shows up as a number.
    expect(ratio(resolve(dark, '--border'), resolve(dark, '--surface-2'))).toBe(3.17);
  });
});

describe('the four sync states cannot be told apart by colour, which is why the words exist', () => {
  const STATES = ['--accent', '--muted', '--warn', '--danger'] as const;

  for (const [scheme, palette] of SCHEMES) {
    it(`${scheme}: every pair of state colours is under 1.3:1`, () => {
      // Far under the 3:1 a meaning-bearing mark needs without text beside it.
      // The day somebody "improves" the palette so these separate, the argument
      // for the glyph and the word looks unnecessary and the next person deletes
      // them; pinning the collision keeps the reason visible.
      for (const a of STATES) {
        for (const b of STATES) {
          if (a === b) continue;
          expect(ratio(resolve(palette, a), resolve(palette, b)), `${a} vs ${b}`).toBeLessThan(1.3);
        }
      }
    });

    it(`${scheme}: the collapse survives a greyscale conversion`, () => {
      for (const a of STATES) {
        for (const b of STATES) {
          if (a === b) continue;
          const value = ratio(greyscale(resolve(palette, a)), greyscale(resolve(palette, b)));
          expect(value).toBeLessThan(AA_UI);
        }
      }
    });
  }
});

describe('remote carets and selections (docs/DESIGN.md 2.4)', () => {
  it('every caret clears 3:1 on its page, and every label clears 4.5:1 for its ink', () => {
    for (const hue of CURSOR_RAMP) {
      expect(
        ratio(hue.light, resolve(light, '--surface')),
        `${hue.name} light caret`,
      ).toBeGreaterThanOrEqual(AA_UI);
      expect(
        ratio(hue.dark, resolve(dark, '--surface')),
        `${hue.name} dark caret`,
      ).toBeGreaterThanOrEqual(AA_UI);
      expect(ratio(hue.lightInk, hue.light), `${hue.name} light label`).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
      expect(ratio(hue.darkInk, hue.dark), `${hue.name} dark label`).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    }
  });

  it('text over a 25% selection tint stays readable in both schemes', () => {
    // The alpha is read from the stylesheet, not assumed, so changing it there is
    // what this test measures.
    const alpha =
      Number(/color-mix\(in srgb, var\(--sel-light[^)]*\)\)\s+(\d+)%/u.exec(globals)?.[1]) / 100;
    expect(alpha).toBe(0.25);
    for (const hue of CURSOR_RAMP) {
      const lightTint = composite(hue.light, resolve(light, '--surface'), alpha);
      const darkTint = composite(hue.dark, resolve(dark, '--surface'), alpha);
      expect(
        ratio(resolve(light, '--text'), lightTint),
        `${hue.name} light`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(ratio(resolve(dark, '--text'), darkTint), `${hue.name} dark`).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    }
  });
});

describe('the parser this file depends on', () => {
  it('reads the dark block from inside its media query', () => {
    const overrides = extractTokens(globals, '@media (prefers-color-scheme: dark)');
    expect(overrides['--bg']).toBe('#171b17');
    expect(overrides['--accent']).toBe('#6fca90');
  });

  it('throws on a token that does not exist rather than skipping it', () => {
    expect(() => resolve(light, '--not-a-token')).toThrow(/undefined token/u);
  });
});
