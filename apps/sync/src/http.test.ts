/**
 * The HTTP surface, driven with real `IncomingMessage`/`ServerResponse` objects
 * over a real `http.Server` on an ephemeral port.
 *
 * Cheap enough for the gate lane -- no database, no Redis, no Hocuspocus -- and
 * it is the only way to prove the thing that actually goes wrong here: two
 * listeners both answering, and the second `writeHead` throwing
 * `ERR_HTTP_HEADERS_SENT`.
 */
import type { Diff, Health, VersionSummary } from '@docs/shared';
import { DomainError } from '@docs/shared';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { mountRoutes, type HttpRoutes } from './http.js';

const HEALTH: Health = {
  status: 'ok',
  service: 'sync',
  version: '0.1.0',
  uptimeSeconds: 5,
  checks: [{ name: 'postgres', status: 'ok', latencyMs: 1, detail: null }],
  connections: 0,
  documents: 0,
};

const DIFF: Diff = {
  from: 1,
  to: 2,
  lines: [{ kind: 'added', text: 'x' }],
  addedLines: 1,
  removedLines: 0,
};
const VERSION: VersionSummary = {
  id: 'cversync0000000000000000',
  n: 4,
  kind: 'MANUAL',
  label: 'Before the rewrite',
  authorName: 'Ada',
  createdAt: '2026-08-26T09:30:00.000Z',
  bytes: 12,
};
const DOCUMENT = 'cdocsync00000000000000000';

/**
 * Any bearer token at all.
 *
 * These routes are authorised inside the route implementations, which are fakes
 * here; what `handle` itself owns is refusing a request that presents NO
 * credential, and handing what was presented to the route unchanged. Both of
 * those are asserted below. The verification itself is `auth.test.ts`.
 */
const BEARER = { authorization: 'Bearer a.token.value' };

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function listening(
  routes: Partial<HttpRoutes> = {},
  fallbackBody = 'Welcome to Hocuspocus!',
) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(fallbackBody);
  });
  servers.push(server);

  const fallback = server.listeners('request')[0] as Parameters<typeof mountRoutes>[1];
  mountRoutes(server, fallback, {
    health: async () => ({ body: HEALTH, status: 200 }),
    diff: async () => DIFF,
    createVersion: async () => VERSION,
    ...routes,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('/health', () => {
  it('answers the health body as JSON, once', async () => {
    // "Once" is the assertion. Leaving Hocuspocus's own request listener in
    // place means two handlers answer, and the second writeHead throws
    // ERR_HTTP_HEADERS_SENT -- which surfaces as a socket hang-up, not as an
    // error anybody sees.
    const base = await listening();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/u);
    expect(await response.json()).toEqual(HEALTH);
  });

  it('is never cached', async () => {
    // A health body cached anywhere between here and the prober describes the
    // past.
    const base = await listening();
    expect((await fetch(`${base}/health`)).headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 when the body says degraded', async () => {
    const base = await listening({
      health: async () => ({ body: { ...HEALTH, status: 'degraded' }, status: 503 }),
    });
    expect((await fetch(`${base}/health`)).status).toBe(503);
  });

  it('leaves every other path to Hocuspocus', async () => {
    const base = await listening();
    const response = await fetch(`${base}/`);
    expect(await response.text()).toBe('Welcome to Hocuspocus!');
  });
});

describe('/documents/:id/diff', () => {
  it('answers a diff', async () => {
    const base = await listening();
    const response = await fetch(`${base}/documents/${DOCUMENT}/diff?from=1&to=2`, {
      headers: BEARER,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DIFF);
  });

  it('treats an absent `to` as the live document', async () => {
    let seen: number | null | undefined;
    const base = await listening({
      diff: async (_credentials, _id, _from, to) => {
        seen = to;
        return DIFF;
      },
    });
    await fetch(`${base}/documents/${DOCUMENT}/diff?from=1`, { headers: BEARER });
    expect(seen).toBeNull();
  });

  it('refuses an unparseable `to` rather than silently meaning the live document', async () => {
    // Falling back would answer a different question than the one asked, and
    // the caller would have no way to tell.
    const base = await listening();
    const response = await fetch(`${base}/documents/${DOCUMENT}/diff?from=1&to=banana`, {
      headers: BEARER,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'INVALID',
      message: '`to` must be a positive version number',
    });
  });

  it('refuses a missing or non-positive `from`', async () => {
    const base = await listening();
    for (const query of ['', '?from=', '?from=0', '?from=-1', '?from=1.5']) {
      const response = await fetch(`${base}/documents/${DOCUMENT}/diff${query}`, {
        headers: BEARER,
      });
      expect(response.status, query).toBe(400);
    }
  });

  it('maps a domain code to its status and never leaks anything else', async () => {
    const base = await listening({
      diff: async () => {
        throw new DomainError('NOT_FOUND', 'No version 9 of this document');
      },
    });
    const response = await fetch(`${base}/documents/${DOCUMENT}/diff?from=9`, { headers: BEARER });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: 'NOT_FOUND',
      message: 'No version 9 of this document',
    });
  });

  it('answers 500 with no detail for an unexpected failure', async () => {
    // An unexpected error here is a stack trace or a database string, and
    // neither belongs on the wire.
    const base = await listening({
      diff: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5440');
      },
    });
    const response = await fetch(`${base}/documents/${DOCUMENT}/diff?from=1`, { headers: BEARER });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 'INTERNAL', message: 'Request failed' });
  });

  it('refuses a method other than GET', async () => {
    const base = await listening();
    const response = await fetch(`${base}/documents/${DOCUMENT}/diff?from=1`, {
      method: 'POST',
      headers: BEARER,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'INVALID', message: 'Use GET' });
  });

  it('does not match a path that is not a document id', async () => {
    // The route pattern is the same shape `idSchema` accepts, so a path
    // traversal or a wildcard falls through to Hocuspocus rather than reaching
    // a database lookup.
    const base = await listening();
    for (const path of [
      '/documents/../diff',
      '/documents/short/diff',
      '/documents/x%2F..%2Fy/diff',
    ]) {
      const response = await fetch(`${base}${path}?from=1`, { headers: BEARER });
      expect(await response.text(), path).toBe('Welcome to Hocuspocus!');
    }
  });
});

/**
 * The credential handling, which both document routes share.
 *
 * These are the assertions that would have caught the endpoint as it shipped
 * before this: `/documents/:id/diff` answered a document's full text to anybody
 * who could guess an id, with no header at all.
 */
describe('credentials', () => {
  it.each([
    ['diff', `/documents/${DOCUMENT}/diff?from=1`, 'GET'],
    ['create a version', `/documents/${DOCUMENT}/versions`, 'POST'],
  ])('refuses a request with no bearer token: %s', async (_name, path, method) => {
    const base = await listening();
    const response = await fetch(`${base}${path}`, {
      method,
      ...(method === 'POST'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) }
        : {}),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'This endpoint needs a service token',
    });
  });

  it('hands the token and the share parameter to the route unchanged', async () => {
    let seen: { token: string; shareToken: string | null } | undefined;
    const base = await listening({
      diff: async (credentials) => {
        seen = { token: credentials.token, shareToken: credentials.shareToken };
        return DIFF;
      },
    });
    await fetch(`${base}/documents/${DOCUMENT}/diff?from=1&share=abcdefghijklmnop`, {
      headers: BEARER,
    });
    expect(seen).toEqual({ token: 'a.token.value', shareToken: 'abcdefghijklmnop' });
  });

  it('reads an absent or empty share parameter as no link', async () => {
    // Not as a refused one. `resolveAccess` distinguishes "presented nothing"
    // from "presented something bad", and an empty string is the former.
    let seen: string | null | undefined;
    const base = await listening({
      diff: async (credentials) => {
        seen = credentials.shareToken;
        return DIFF;
      },
    });
    await fetch(`${base}/documents/${DOCUMENT}/diff?from=1&share=`, { headers: BEARER });
    expect(seen).toBeNull();
    await fetch(`${base}/documents/${DOCUMENT}/diff?from=1`, { headers: BEARER });
    expect(seen).toBeNull();
  });
});

describe('POST /documents/:id/versions', () => {
  async function post(base: string, body: unknown, headers: Record<string, string> = BEARER) {
    return fetch(`${base}/documents/${DOCUMENT}/versions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('answers 201 with the version it cut', async () => {
    const base = await listening();
    const response = await post(base, { label: 'Before the rewrite' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(VERSION);
  });

  it('passes the label through', async () => {
    let seen: string | undefined;
    const base = await listening({
      createVersion: async (_credentials, _id, label) => {
        seen = label;
        return VERSION;
      },
    });
    await post(base, { label: 'Before the rewrite' });
    expect(seen).toBe('Before the rewrite');
  });

  /**
   * A manual version with no label is a row nobody can identify in the panel,
   * which is the same as a row that is not there -- except that it counts
   * against the cap and pushes a real one out. `versionLabelSchema` turns an
   * absent label into `null`, so this is the branch that refuses it.
   */
  it.each([[{}], [{ label: null }], [{ label: '   ' }], [{ label: 'x'.repeat(81) }]])(
    'refuses a version with no usable name: %j',
    async (body) => {
      const base = await listening();
      const response = await post(base, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: 'INVALID',
        message: 'A saved version needs a name',
      });
    },
  );

  it('refuses a body that is not JSON', async () => {
    const base = await listening();
    const response = await fetch(`${base}/documents/${DOCUMENT}/versions`, {
      method: 'POST',
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'INVALID',
      message: 'That request body is not JSON',
    });
  });

  /**
   * Counted while reading rather than taken from `content-length`, which is a
   * number the client chose. A body that never ends would otherwise hold the
   * connection open indefinitely.
   */
  it('refuses a body past the ceiling', async () => {
    const base = await listening();
    const response = await post(base, { label: 'x'.repeat(5000) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: 'TOO_LARGE',
      message: 'That request body is too long',
    });
  });

  it('refuses a method other than POST', async () => {
    const base = await listening();
    const response = await fetch(`${base}/documents/${DOCUMENT}/versions`, { headers: BEARER });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'INVALID', message: 'Use POST' });
  });
});
