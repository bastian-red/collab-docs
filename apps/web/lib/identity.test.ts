import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CURSOR_RAMP } from '@docs/shared';
import { describe, expect, it } from 'vitest';

import { extractTokens, resolve, stripCssComments } from './contrast';

/**
 * The identity lock: "a desk with a page on it" (docs/SPECS.md 8, DESIGN.md 2).
 *
 * Pins the desk, the page, the accent, the radius and the exact three faces, read
 * out of `app/globals.css` and `app/layout.tsx`. What breaks without it is the
 * portfolio's actual failure mode: every project drifting toward whatever the last
 * one wore. A redesign that drifts compiles, renders, and passes every other test.
 * Changing an identity means editing this file deliberately.
 */
const APP = join(__dirname, '..', 'app');
const globals = stripCssComments(readFileSync(join(APP, 'globals.css'), 'utf8'));
const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');

const IDENTITY = {
  light: { '--bg': '#e4e8e0', '--surface': '#ffffff', '--accent': '#1a6b3c' },
  dark: { '--bg': '#171b17', '--surface': '#20251f', '--accent': '#6fca90' },
  radius: '12px',
  fonts: ['Karla', 'Red_Hat_Mono', 'Spectral'],
} as const;

const light = extractTokens(globals, ':root');
const dark = { ...light, ...extractTokens(globals, '@media (prefers-color-scheme: dark)') };

/**
 * The faces from `next/font/google`, with the same regex
 * `web/scripts/identity-distinct.mjs` uses. ONE import, single-quoted: split it or
 * double-quote it and the cross-repo check reads zero faces from this project and
 * reports success while checking nothing.
 */
function importedFaces(): string[] {
  const line = /import\s*\{([^}]*)\}\s*from\s*'next\/font\/google'/.exec(layout);
  if (!line) throw new Error('layout.tsx imports nothing from next/font/google');
  return line[1]!
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

describe('visual identity', () => {
  it.each(Object.entries(IDENTITY.light))('light %s is %s', (token, expected) => {
    expect(resolve(light, token).toLowerCase()).toBe(expected);
  });

  it.each(Object.entries(IDENTITY.dark))('dark %s is %s', (token, expected) => {
    expect(resolve(dark, token).toLowerCase()).toBe(expected);
  });

  it('the page is lighter than the desk in light mode, which is the whole idea', () => {
    // In every sibling the background is paper. Here the page is a distinct
    // object ON the desk; a desk as light as the page erases it.
    expect(resolve(light, '--surface')).not.toBe(resolve(light, '--bg'));
    expect(resolve(light, '--surface-2')).not.toBe(resolve(light, '--surface'));
  });

  it('loads exactly the faces this identity is built on', () => {
    expect(importedFaces()).toEqual([...IDENTITY.fonts].sort());
  });

  it('keeps the one font import in the shape the cross-repo check can parse', () => {
    const imports = [...layout.matchAll(/from\s*['"]next\/font\/google['"]/g)];
    expect(imports, 'exactly one next/font/google import statement').toHaveLength(1);
    expect(importedFaces().length).toBe(3);
  });

  it('wires each face to the variable the stylesheet reads', () => {
    for (const variable of ['--font-prose', '--font-ui', '--font-mono']) {
      expect(layout).toContain(`variable: '${variable}'`);
    }
  });

  it('is cornered at 12px', () => {
    expect(light['--radius']).toBe(IDENTITY.radius);
  });

  it('does not reintroduce the shared signal red or the banned generator tics', () => {
    expect([...globals.matchAll(/#ff0000|#f00\b/gi)]).toHaveLength(0);
    expect(globals).not.toMatch(/--ff-dot|--dot-grid|--font-dot/);
  });
});

describe('the accent means "synced", so nothing else may look like it', () => {
  it('no status colour is the accent, in either scheme', () => {
    for (const scheme of [light, dark]) {
      const accent = resolve(scheme, '--accent').toLowerCase();
      for (const state of ['--warn', '--danger', '--muted']) {
        expect(resolve(scheme, state).toLowerCase(), state).not.toBe(accent);
      }
    }
  });

  it('no caret hue is the accent or a status colour', () => {
    // A green caret reads as "synced", an amber one as "offline" (DESIGN.md 2.4).
    const reserved = new Set(
      [light, dark].flatMap((scheme) =>
        ['--accent', '--warn', '--danger'].map((token) => resolve(scheme, token).toLowerCase()),
      ),
    );
    for (const hue of CURSOR_RAMP) {
      expect(reserved.has(hue.light.toLowerCase()), hue.name).toBe(false);
      expect(reserved.has(hue.dark.toLowerCase()), hue.name).toBe(false);
    }
  });
});

/**
 * What the rest of the portfolio already spent. `web/scripts/identity-distinct.mjs`
 * is the authority (it reads the siblings' real stylesheets); this is the half a
 * single repo can check inside its own pre-commit gate.
 */
const SPENT = {
  canvases: [
    '#fafaf8',
    '#101319', // 001
    '#fffdfa',
    '#14120e',
    '#f6f7f9',
    '#0d1117', // 002
    '#f8fafc',
    '#0b1220',
    '#fbf8f3',
    '#14120f', // 003
    '#f7f6fb',
    '#12111a', // 004
    '#ecedf0',
    '#191621', // 005
    '#f4f1e8',
    '#15191c', // 006
  ],
  accents: [
    '#4f46e5',
    '#818cf8', // 001
    '#7a2e2e',
    '#e39a9a',
    '#1f6feb',
    '#58a6ff', // 002
    '#1d4ed8',
    '#60a5fa',
    '#0f766e',
    '#5eead4', // 003
    '#6d28d9',
    '#a78bfa', // 004
    '#a01a6d',
    '#f4a3d6', // 005
    '#0d6b85',
    '#63c9e6', // 006
  ],
  faces: [
    'Fraunces',
    'Inter', // 001
    'Archivo',
    'IBM_Plex_Mono',
    'Instrument_Serif', // 002
    'IBM_Plex_Sans',
    'JetBrains_Mono',
    'Source_Serif_4', // 003
    'Newsreader',
    'Public_Sans',
    'Roboto_Mono', // 004
    'DM_Mono',
    'Manrope',
    'Sora', // 005
    'Azeret_Mono',
    'Figtree',
    'Literata', // 006
  ],
} as const;

describe('no two projects share an identity', () => {
  it.each([
    ['light', light],
    ['dark', dark],
  ])('%s: the desk is this project alone', (scheme, palette) => {
    const canvas = resolve(palette, '--bg').toLowerCase();
    expect(SPENT.canvases, `${scheme} canvas ${canvas}`).not.toContain(canvas);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('%s: the accent is this project alone', (scheme, palette) => {
    const accent = resolve(palette, '--accent').toLowerCase();
    expect(SPENT.accents, `${scheme} accent ${accent}`).not.toContain(accent);
  });

  it('loads no typeface another project already uses', () => {
    expect(
      importedFaces().filter((face) => (SPENT.faces as readonly string[]).includes(face)),
    ).toEqual([]);
  });
});
