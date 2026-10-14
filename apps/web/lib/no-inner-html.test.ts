/**
 * `dangerouslySetInnerHTML` does not appear in this app (docs/CODESTYLE.md 17).
 *
 * The one place it would be tempting is a search snippet, whose highlights come
 * back from Postgres around text somebody typed into a document. That is rendered
 * by splitting (`lib/snippet.ts`), and this gate keeps it that way.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/u.test(path) && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('no raw HTML injection', () => {
  it('no component sets innerHTML', () => {
    const files = ['app', 'components', 'lib'].flatMap((dir) => walk(join(WEB, dir)));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((file) =>
      /dangerouslySetInnerHTML|\.innerHTML\s*=/u.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => file.slice(WEB.length + 1))).toEqual([]);
  });
});
