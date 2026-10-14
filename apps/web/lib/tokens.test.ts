import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The dangling-token gate.
 *
 * What it pins: every `var(--x)` this app ships resolves to something. Either a
 * stylesheet declares it, or every reference supplies its own fallback, or it is
 * one of the names `next/font` injects at runtime.
 *
 * What breaks without it: nothing any other check can see. An undeclared custom
 * property does not warn, does not throw and does not fail a type check. Inside
 * `calc()` it is worse: per CSS Values 4 a `var()` that resolves to nothing makes
 * the whole declaration invalid at computed-value time, so the property drops to
 * its initial value. In SVG `fill` it falls back to black. A sibling repo shipped
 * exactly that after a token rename, and every test stayed green.
 *
 * Per-person colours (caret, avatar, selection) arrive as inline custom
 * properties set from `cursorColour()`, so the stylesheet cannot declare them;
 * every reference to one carries a fallback, which is the escape hatch below.
 */
const WEB = join(__dirname, '..');
const APP = join(WEB, 'app');
const SKIP = new Set(['node_modules', '.next', '.turbo', 'dist']);

/** Block comments in CSS and TS, plus whole-line `//` comments (not trailing: `http://`). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function walk(dir: string, accept: (entry: string) => boolean, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, accept, found);
    else if (accept(entry)) found.push(path);
  }
  return found;
}

/** Every file that reaches the DOM. Test files are fixtures, not references. */
const sourceFiles = (): string[] =>
  ['app', 'components', 'lib'].flatMap((dir) =>
    walk(join(WEB, dir), (entry) => /\.(tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry)),
  );

const stylesheets = (): string[] => walk(APP, (entry) => entry.endsWith('.css'));

/** Every `--name:` at a declaration position, in any block of any stylesheet. */
function declaredTokens(): Set<string> {
  const declared = new Set<string>();
  for (const file of stylesheets()) {
    const css = stripComments(readFileSync(file, 'utf8'));
    for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) declared.add(match[1]!);
  }
  return declared;
}

/**
 * The names `next/font` writes onto `<html>`, read from `app/layout.tsx`
 * (`variable: '--font-display'`). Derived rather than pinned, so a typo on
 * either side leaves a reference with no declaration and fails below.
 */
function injectedByNextFont(): Set<string> {
  const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');
  return new Set([...layout.matchAll(/variable:\s*['"](--[\w-]+)['"]/g)].map((m) => m[1]!));
}

interface Reference {
  token: string;
  file: string;
  hasFallback: boolean;
}

function references(): Reference[] {
  const found: Reference[] = [];
  for (const path of sourceFiles()) {
    const source = stripComments(readFileSync(path, 'utf8'));
    for (const match of source.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      found.push({
        token: match[1]!,
        file: path.slice(WEB.length + 1),
        hasFallback: match[2] === ',',
      });
    }
  }
  return found;
}

describe('design tokens', () => {
  const declared = declaredTokens();
  const injected = injectedByNextFont();
  const referenced = references();
  const names = new Set(referenced.map((reference) => reference.token));

  it('found tokens on both sides, so the scan is actually running', () => {
    // A walk that silently returned nothing would make every assertion below
    // vacuously true, which is the failure mode of every scanning test.
    expect(declared.size, 'declarations found in app/**/*.css').toBeGreaterThan(15);
    expect(names.size, 'distinct var() references found').toBeGreaterThan(10);
    expect(injected.size, 'next/font variables in app/layout.tsx').toBeGreaterThan(0);
  });

  it('every referenced token resolves to something at runtime', () => {
    const byToken = new Map<string, Reference[]>();
    for (const reference of referenced) {
      byToken.set(reference.token, [...(byToken.get(reference.token) ?? []), reference]);
    }

    // Undeclared is fine only when every use supplies its own fallback. "Some
    // uses have one" is the dangerous middle: the one without is the one that breaks.
    const dangling = [...byToken.entries()]
      .filter(
        ([token, uses]) =>
          !declared.has(token) && !injected.has(token) && !uses.every((u) => u.hasFallback),
      )
      .map(([token, uses]) => {
        const where = [...new Set(uses.filter((use) => !use.hasFallback).map((use) => use.file))];
        return `${token} used without a fallback in ${where.join(', ')}`;
      })
      .sort();

    expect(dangling, 'these var() references resolve to nothing at runtime').toEqual([]);
  });

  it('every next/font variable is actually used by the stylesheet', () => {
    // The other half of the wiring: a font loaded and never referenced costs a
    // download and renders nothing.
    const unused = [...injected].filter((token) => !names.has(token));
    expect(unused, 'next/font variables no var() reads').toEqual([]);
  });
});
