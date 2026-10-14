/**
 * The module-system boundary, as a test.
 *
 * docs/SPECS.md section 2.2: "the document text is written only by
 * `apps/sync`". The mechanism that enforces it is `packages/db`'s export map --
 * `@docs/db/documents` publishes an `import` condition and no `require` one, so
 * the CommonJS API cannot reach the CRDT repository even by accident. That is a
 * one-line change away from being untrue, and nothing would fail: the API would
 * simply gain the ability to rewrite documents behind the sync server's back.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, Record<string, string>>;
};

describe('the @docs/db export map', () => {
  it('publishes the CRDT repository to ES modules only', () => {
    const documents = manifest.exports['./documents']!;
    expect(Object.keys(documents).sort()).toEqual(['import', 'types']);
    expect(documents['require']).toBeUndefined();
  });

  it('points that subpath at ESM output, so the condition cannot be satisfied by a .js file', () => {
    const documents = manifest.exports['./documents']!;
    expect(documents['import']).toMatch(/\.mjs$/u);
    expect(documents['types']).toMatch(/\.d\.mts$/u);
  });

  it('keeps the root entry point reachable from both module systems', () => {
    // apps/api (CommonJS) and apps/sync (ESM) both read constraint names and
    // error helpers from here.
    const root = manifest.exports['.']!;
    expect(root['require']).toBeDefined();
    expect(root['import']).toBeDefined();
  });
});

describe('the CommonJS half of this package', () => {
  const commonjsSources = readdirSync(join(packageRoot, 'src'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(packageRoot, 'src', name), 'utf8') }));

  it('has files to check, so a rename cannot make this suite vacuous', () => {
    expect(commonjsSources.length).toBeGreaterThan(0);
  });

  it('never names an ESM-only dependency', () => {
    // `yjs` and `@docs/doc-store` ship ESM-only type declarations. A `.ts` file
    // here that imports either fails to typecheck with TS1479 -- but the failure
    // is a wall of module-resolution prose, and the temptation is to "fix" it by
    // switching the whole package to `"type": "module"`, which breaks NestJS.
    // The rule, stated once: the Yjs stack is reachable from `.mts` here and
    // nowhere else.
    for (const source of commonjsSources) {
      expect(source.text, source.name).not.toMatch(/from '(yjs|@docs\/doc-store)'/u);
    }
  });
});

describe('the boundary at runtime, not only in the manifest', () => {
  it('refuses a require() of the CRDT repository', () => {
    // The manifest checks above say the condition is absent. This says Node
    // agrees, which is the claim that actually matters: `apps/api` is CommonJS,
    // so this is the exact call it would make.
    //
    // Uses the built package, so it also fails if `dist/` was never built or the
    // export map points at a file that is not there -- a broken map and a
    // correctly refused import look identical from the manifest alone.
    let code = 'no error';
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@docs/db/documents');
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code ?? 'no code';
    }
    expect(code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('still resolves the root entry point from require()', () => {
    // The other half: if this also failed, the test above would be passing
    // because the package is unresolvable, not because the boundary works.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const root = require('@docs/db') as Record<string, unknown>;
    expect(typeof root['createPrismaClient']).toBe('function');
    expect(typeof root['ONE_OWNER_PER_DOCUMENT']).toBe('string');
  });
});
