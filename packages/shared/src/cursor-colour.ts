/**
 * Which colour a person's caret is, in everybody's browser.
 *
 * Two properties, and the second is the one that is easy to get wrong:
 *
 *   1. Deterministic. The same user id yields the same hue in every process, so
 *      Ana is one colour in Bruno's tab and the same colour in Clara's. A colour
 *      picked per client -- `Math.random()`, an index into the connected list, a
 *      hash of the connection id -- gives one person a different hue in each
 *      tab, and then the label is not a redundant channel, it is the ONLY
 *      channel.
 *   2. Never the accent, and never a status colour. `--accent` means "synced"
 *      and amber means "offline"; a caret in either of those is a sentence the
 *      interface did not mean to write. `apps/web/lib/identity.test.ts` asserts
 *      the disjointness against the real stylesheet.
 *
 * Measured before being written, in both schemes (see docs/SPECS.md 8.2 for the
 * method): every hue clears 3:1 against its page as a non-text mark and 4.5:1
 * as the label's background against the label ink.
 *
 * What this module deliberately does NOT do is make the hues distinguishable
 * from each other. The worst pair here sits at 1.01:1 -- teal and rose are the
 * same grey. Eight hues cannot be told apart by a reader with a colour-vision
 * deficiency, and pretending otherwise is how a design ends up relying on the
 * one channel that fails. Every caret carries the writer's NAME, always
 * rendered, never on hover.
 */

export interface CursorColour {
  /** The caret and its label background on the light page. */
  readonly light: string;
  /** The same, on the dark page. */
  readonly dark: string;
  /** Ink for the label, chosen per scheme so the name clears 4.5:1 on the hue. */
  readonly lightInk: string;
  readonly darkInk: string;
  /** For a screen reader and for a test that must not assert on a hex. */
  readonly name: string;
}

const RAMP: readonly CursorColour[] = Object.freeze(
  [
    { name: 'blue', light: '#1f5fa8', dark: '#8ab8ee', lightInk: '#ffffff', darkInk: '#101410' },
    { name: 'magenta', light: '#b0407a', dark: '#f0a8cf', lightInk: '#ffffff', darkInk: '#101410' },
    { name: 'teal', light: '#0f6b78', dark: '#67cfdd', lightInk: '#ffffff', darkInk: '#101410' },
    { name: 'purple', light: '#8c3fb0', dark: '#c9a4f0', lightInk: '#ffffff', darkInk: '#101410' },
    { name: 'slate', light: '#46566b', dark: '#aebdd0', lightInk: '#ffffff', darkInk: '#101410' },
    { name: 'brown', light: '#7a4a2e', dark: '#dfae86', lightInk: '#ffffff', darkInk: '#101410' },
    { name: 'rose', light: '#a83a5b', dark: '#f2a0b6', lightInk: '#ffffff', darkInk: '#101410' },
    { name: 'indigo', light: '#4a3fb0', dark: '#a9a4f2', lightInk: '#ffffff', darkInk: '#101410' },
  ].map((entry) => Object.freeze(entry)),
);

export const CURSOR_RAMP = RAMP;

/**
 * FNV-1a, 32 bit.
 *
 * Written out rather than taken from `node:crypto` because this module is in the
 * browser entry point of `@docs/shared` and must not pull a Node builtin into
 * the client bundle. It is not a security primitive and nothing depends on it
 * being hard to invert: it only has to spread cuids across eight buckets and
 * give the same answer in Node and in a browser, forever.
 *
 * `>>> 0` on every step keeps it in unsigned 32-bit space; without it the
 * multiply overflows into a double and two ids that differ late in the string
 * start colliding.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The caret colour for a user id. Total: every string gets an answer. */
export function cursorColour(userId: string): CursorColour {
  return RAMP[fnv1a(userId) % RAMP.length]!;
}
