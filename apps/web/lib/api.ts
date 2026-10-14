import 'server-only';

/**
 * The server-side client for both of this app's backends.
 *
 * **The browser never calls `apps/api` or `apps/sync` over HTTP** (docs/SPECS.md
 * 12.3). Server components read through `apiFetch`, server actions write through
 * it, and the one HTTP route that lives on the sync server (diff, manual version)
 * goes through `syncFetch`. One origin for the browser means no CORS surface on
 * either backend and no REST credential in browser JavaScript.
 *
 * **A fresh token per call, never one cached in module scope.** Service tokens
 * live 120 seconds. A module-level token in a long-lived Node process is valid
 * for two minutes after a deploy and rejected for the rest of the day, which is
 * the hardest shape of bug to reproduce. Minting is one HMAC; it is not worth
 * caching.
 *
 * `import 'server-only'` is the enforcement: a client component that imported
 * this for its types would pull `jsonwebtoken` and `AUTH_SECRET` into the browser
 * bundle, and the build fails instead.
 *
 * Every response is parsed with its `@docs/shared` schema. A page renders
 * whatever it is handed, so an API that drifted would produce a blank region
 * rather than an error, and the failure would be blamed on CSS.
 */
import type { SessionUser } from '@docs/shared';
import { mintServiceToken } from '@docs/shared/server';
import type { z } from 'zod';

import { apiBaseUrl, authSecret, syncBaseUrl } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
}

async function call<T>(
  baseUrl: string,
  user: SessionUser | null,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: RequestOptions,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      // `null` only for the two `@Public()` auth routes, which is the honest
      // shape: there is no session yet, so there is nobody to mint a token for.
      ...(user === null ? {} : { authorization: `Bearer ${mintServiceToken(user, authSecret())}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    // Every route here is per-session and changes as people type. Next's data
    // cache holding one is a document list showing a title renamed an hour ago.
    cache: 'no-store',
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    // A non-JSON body means a proxy or an error page answered instead of the app.
    // Reported below with the status, which is the only useful thing left.
  }

  if (!response.ok) {
    const problem = payload as { code?: unknown; message?: unknown } | null;
    throw new ApiError(
      response.status,
      typeof problem?.code === 'string' ? problem.code : 'INTERNAL',
      typeof problem?.message === 'string'
        ? problem.message
        : `The server answered ${String(response.status)}.`,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // Issues go to the server log, never to the page: they quote the payload back,
    // and the payload is somebody's document.
    console.error(`[web] ${path} did not match its contract`, parsed.error.issues);
    throw new ApiError(
      500,
      'INTERNAL',
      'The server returned something this app does not understand.',
    );
  }
  return parsed.data;
}

/**
 * One call to `apps/api`, parsed. The schema is a parameter, not a generic with a
 * cast, so there is no overload that returns unparsed JSON.
 */
export function apiFetch<T>(
  user: SessionUser | null,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: RequestOptions = {},
): Promise<T> {
  return call(apiBaseUrl, user, path, schema, options);
}

/**
 * One authenticated call to `apps/sync`'s HTTP routes.
 *
 * Separate from `apiFetch` because the two routes it serves (`/documents/:id/diff`
 * and `POST /documents/:id/versions`) live where the CRDT lives: computing a diff
 * materialises two `Y.Doc`s and cutting a version needs the un-compacted log, and
 * `apps/api` can do neither by construction (docs/SPECS.md 5.4).
 */
export function syncFetch<T>(
  user: SessionUser,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: RequestOptions = {},
): Promise<T> {
  return call(syncBaseUrl, user, path, schema, options);
}

/** A query string from the defined entries only, so `undefined` never becomes the text "undefined". */
export function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export interface Probe {
  readonly reachable: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly error: string | null;
}

/**
 * A health probe, which is the one call that must not throw.
 *
 * `/status` renders the failure rather than failing with it: a page that 500s
 * because a dependency is down cannot tell you the dependency is down. Bounded at
 * three seconds so one hung replica does not hang the page.
 */
export async function probeHealth(baseUrl: string): Promise<Probe> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    return { reachable: true, status: response.status, body: await response.json(), error: null };
  } catch (error) {
    // The error CLASS, never the message: a connection error's message carries the
    // host and port, which is internal topology on a public status page.
    const name = error instanceof Error ? error.name : 'Error';
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    return {
      reachable: false,
      status: 0,
      body: null,
      error: typeof code === 'string' ? code : name,
    };
  }
}
