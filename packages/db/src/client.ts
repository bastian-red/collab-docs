/**
 * How a Prisma client is made, in one place.
 *
 * Callers ask this package for a client rather than importing
 * `../generated/client` themselves. Three reasons, and the third is the one that
 * bites:
 *
 *   - The generated client lives at `packages/db/generated/`, NOT in
 *     `node_modules`, because `pnpm deploy --prod` in a Docker build rebuilds
 *     `node_modules` and drops a client generated there. Every consumer would
 *     otherwise have to know that relative path.
 *   - Log configuration is one decision, not one per app.
 *   - `apps/sync` is an ES module and this package is CommonJS. A factory
 *     function is a plain named export that `cjs-module-lexer` can see, so
 *     `import { createPrismaClient } from '@docs/db'` works from ESM. Reaching
 *     into the generated client from ESM does not: it is built by assignment and
 *     the lexer cannot always follow it.
 */
import { Prisma, PrismaClient } from '../generated/client';

export type { PrismaClient };

/**
 * Prisma's tagged-template helpers, re-exported so a caller never reaches into
 * `../generated/client` for them.
 *
 * `Prisma.sql` and `Prisma.raw` are what make a parameterised raw query
 * possible at all: the full-text search in `apps/api` has to interpolate
 * `DOCUMENT_SEARCH_VECTOR` -- a frozen constant of ours -- as SQL, while the
 * user's search text stays a bound parameter. The alternative is
 * `$queryRawUnsafe` with the search text concatenated in, which is the textbook
 * injection.
 */
export { Prisma };

export interface ClientOptions {
  /** Overrides `DATABASE_URL`, so a caller that already validated its config passes it in. */
  readonly url?: string;
  /** Query logging. Off by default: a sync server logs one line per keystroke otherwise. */
  readonly logQueries?: boolean;
}

export function createPrismaClient(options: ClientOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(options.url === undefined ? {} : { datasources: { db: { url: options.url } } }),
    log: options.logQueries === true ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}
