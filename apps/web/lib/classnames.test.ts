/**
 * Class names a component uses that the stylesheet never defines.
 *
 * `className="messge-row"` compiles, typechecks and renders an unstyled element in
 * a styled page, and nothing says a word. There is one hand-written stylesheet
 * and no CSS modules or utility framework here (docs/CODESTYLE.md 17), so "every
 * class must appear as a selector in app/globals.css" is a complete rule.
 *
 * Three static shapes are read: `className="..."` and `className={\`...\`}` in
 * JSX, and `.className = '...'` / `class: '...'` in the editor island, where the
 * caret label and the ProseMirror attributes are built imperatively. Computed
 * classes are out of scope; this is a string check, not a dataflow analysis.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..');
const globals = readFileSync(join(WEB, 'app', 'globals.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const ROOTS = [join(WEB, 'app'), join(WEB, 'components')];

const styled = new Set([...globals.matchAll(/\.([a-z][\w-]*)/g)].map((match) => match[1]!));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

interface Usage {
  readonly file: string;
  readonly name: string;
}

const usages: Usage[] = ROOTS.flatMap(walk).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  const found: Usage[] = [];
  const patterns = [
    /className=(?:"([^"]*)"|\{`([^`$]*)`\})/g,
    /\.className\s*=\s*'([^']*)'/g,
    /\bclass:\s*'([^']*)'/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? '';
      for (const name of value.split(/\s+/u).filter((part) => part.length > 0)) {
        found.push({ file: file.slice(WEB.length + 1), name });
      }
    }
  }
  return found;
});

describe('every class a component names is in the stylesheet', () => {
  it('found some, so a broken regex fails loudly instead of passing over nothing', () => {
    expect(usages.length).toBeGreaterThan(100);
    expect(styled.size).toBeGreaterThan(80);
    // The imperative shapes specifically, which is where a regex is likeliest to rot.
    expect(usages.some((usage) => usage.name === 'caret-label')).toBe(true);
    expect(usages.some((usage) => usage.name === 'remote-selection')).toBe(true);
  });

  it('has no class that renders nothing', () => {
    const unstyled = usages.filter((usage) => !styled.has(usage.name));
    expect(unstyled.map((usage) => `${usage.file}: .${usage.name}`)).toEqual([]);
  });
});
