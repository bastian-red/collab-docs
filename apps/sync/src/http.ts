/**
 * The HTTP surface beside the websocket: `/health`, the version diff, and cutting
 * a version by hand.
 *
 * **Why these two routes are here and not in `apps/api`.** Both need a `Y.Doc`.
 * A diff means materialising two stored states; cutting a version means encoding
 * the document's current one. `apps/api` is CommonJS and `@docs/db/documents`
 * publishes no `require` condition, so it cannot reach the repository that owns
 * either (docs/CODESTYLE.md section 9). The endpoint follows the capability.
 *
 * **Both are authorised, and by the same function the socket handshake uses.**
 * A route here with its own idea of who may read a document would be a second
 * enforcement point, and the weaker of two is the one an attacker gets to choose.
 * `/health` is the deliberate exception: a probe that needs a credential is a
 * probe a container runtime cannot run, and it reports dependency status, never
 * document content.
 *
 * **Why the request listener is replaced rather than the `onRequest` hook used.**
 * Hocuspocus's `Server` builds its own `http.Server` with one listener that
 * answers `Welcome to Hocuspocus!` to every path. The documented way to add a
 * route is the `onRequest` extension hook -- and that hook signals "I have
 * handled this" by REJECTING. Read out of the shipped bundle:
 * `Hocuspocus.hooks` logs and rethrows (`hocuspocus-server.esm.js:1563`), and
 * the request handler's own catch rethrows again (`:1638`), out of an async
 * listener with nothing above it. Under Node's default that is an
 * `unhandledRejection`, which terminates the process. A container health probe
 * every ten seconds would take the sync server down every ten seconds.
 *
 * So the listener is swapped: ours runs first, answers what it owns, and hands
 * everything else to the same `requestHandler` Hocuspocus installed. Nothing is
 * reimplemented; the routing decision is simply ours.
 */
import {
  DomainError,
  createVersionSchema,
  httpStatusForCode,
  isDomainError,
  type Diff,
  type Health,
  type VersionSummary,
} from '@docs/shared';
import { readBearer } from '@docs/shared/server';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';

/**
 * What a request presented, before anything has been verified.
 *
 * Two separate credentials with two different lifetimes: the bearer token says
 * who you are and expires in two minutes, the share token says what you were
 * given and lives until it is revoked. Extracted here so the route
 * implementations receive data rather than an `IncomingMessage`.
 */
export interface RequestCredentials {
  readonly token: string;
  readonly shareToken: string | null;
}

export interface HttpRoutes {
  health(): Promise<{ body: Health; status: number }>;
  diff(
    credentials: RequestCredentials,
    documentId: string,
    from: number,
    to: number | null,
  ): Promise<Diff>;
  createVersion(
    credentials: RequestCredentials,
    documentId: string,
    label: string,
  ): Promise<VersionSummary>;
}

const DIFF_PATH = /^\/documents\/([A-Za-z0-9]{20,40})\/diff$/u;
const VERSIONS_PATH = /^\/documents\/([A-Za-z0-9]{20,40})\/versions$/u;

/**
 * The largest request body this server will read.
 *
 * A version label is at most 80 characters. Anything approaching this is a
 * client bug or somebody probing, and the bound is enforced while READING rather
 * than after, so a body that never ends cannot hold a socket open forever.
 */
const MAX_BODY_BYTES = 4096;

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  options: { close?: boolean } = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // A health body cached by anything between here and the prober is a health
    // body that describes the past.
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    // Set only when we stopped reading the body early. The unread remainder
    // would otherwise sit in the socket and be parsed as the next request.
    ...(options.close === true ? { connection: 'close' } : {}),
  });
  response.end(payload);
}

export async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  routes: HttpRoutes,
): Promise<boolean> {
  // `request.url` is a path with a query, never an absolute URL, so the base is
  // a placeholder that is never used for anything.
  const url = new URL(request.url ?? '/', 'http://sync.invalid');

  if (url.pathname === '/health') {
    const { body, status } = await routes.health();
    json(response, status, body);
    return true;
  }

  const diffMatch = DIFF_PATH.exec(url.pathname);
  if (diffMatch !== null) {
    await answer(response, async () => {
      if (request.method !== 'GET') throw new DomainError('INVALID', 'Use GET');
      const credentials = credentialsOf(request, url);
      const from = versionNumber(url.searchParams.get('from'), 'from');
      const rawTo = url.searchParams.get('to');
      // Absent means the live document. Present-but-unparseable is an error
      // rather than a silent fallback to the live document, which would answer a
      // different question than the one asked.
      const to = rawTo === null ? null : versionNumber(rawTo, 'to');
      return { status: 200, body: await routes.diff(credentials, diffMatch[1]!, from, to) };
    });
    return true;
  }

  const versionsMatch = VERSIONS_PATH.exec(url.pathname);
  if (versionsMatch !== null) {
    await answer(response, async () => {
      if (request.method !== 'POST') throw new DomainError('INVALID', 'Use POST');
      const credentials = credentialsOf(request, url);
      const body = await readJson(request);
      // The same `createVersionSchema` the API and the web app parse with. A
      // label typed here is a label somebody has to recognise in a list later,
      // and `normaliseLabel` in `@docs/versioning` is what makes two of them
      // comparable; this is only the wire check.
      const parsed = createVersionSchema.safeParse(body);
      if (!parsed.success || parsed.data.label === null) {
        throw new DomainError('INVALID', 'A saved version needs a name');
      }
      return {
        status: 201,
        body: await routes.createVersion(credentials, versionsMatch[1]!, parsed.data.label),
      };
    });
    return true;
  }

  return false;
}

/**
 * Run a route and answer, mapping a typed code to a status.
 *
 * One place, so a route added later cannot forget it -- and so an unexpected
 * error can never put its message on the wire. A stack trace or a connection
 * string is exactly what an unclassified error's text tends to be.
 */
async function answer(
  response: ServerResponse,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  try {
    const { status, body } = await run();
    json(response, status, body);
  } catch (error) {
    if (isDomainError(error)) {
      json(
        response,
        httpStatusForCode(error.code),
        { code: error.code, message: error.message },
        // The one code that means "we stopped reading you".
        { close: error.code === 'TOO_LARGE' },
      );
      return;
    }
    console.error('[sync] request failed:', error);
    json(response, 500, { code: 'INTERNAL', message: 'Request failed' });
  }
}

/**
 * The two credentials a request may carry.
 *
 * A missing bearer token is refused HERE rather than inside the verifier, so an
 * unauthenticated caller gets 401 and never reaches a database lookup keyed on
 * anything they sent.
 */
function credentialsOf(request: IncomingMessage, url: URL): RequestCredentials {
  const token = readBearer(request.headers.authorization);
  if (token === null) {
    throw new DomainError('UNAUTHENTICATED', 'This endpoint needs a service token');
  }
  const share = url.searchParams.get('share')?.trim();
  return { token, shareToken: share === undefined || share === '' ? null : share };
}

/**
 * Read a JSON body, refusing one that is too long WHILE reading it.
 *
 * Checking `content-length` instead would be checking a number the client chose.
 * Counting as the chunks arrive and destroying the socket at the ceiling is what
 * stops an endless body from holding a connection open indefinitely.
 */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      // Paused, not destroyed. `request.destroy()` cuts the socket under the
      // response we are about to write, so the caller sees `ECONNRESET` instead
      // of the 413 that would tell them what to fix. Pausing stops us reading;
      // `connection: close` on the reply is what stops the unread remainder
      // being parsed as the next request on a keep-alive socket.
      request.pause();
      throw new DomainError('TOO_LARGE', 'That request body is too long');
    }
    chunks.push(buffer);
  }

  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('INVALID', 'That request body is not JSON');
  }
}

function versionNumber(raw: string | null, name: string): number {
  const parsed = Number(raw);
  if (raw === null || raw.trim() === '' || !Number.isInteger(parsed) || parsed < 1) {
    throw new DomainError('INVALID', `\`${name}\` must be a positive version number`);
  }
  return parsed;
}

/**
 * Put our listener in front of the one Hocuspocus installed.
 *
 * `removeAllListeners('request')` then re-adding is deliberate and is the only
 * way round Node's request dispatch: every `request` listener runs, and there is
 * no way for one to stop the others. Leaving Hocuspocus's in place would mean
 * `/health` answered twice -- ours with JSON, theirs with
 * `Welcome to Hocuspocus!` -- and the second `writeHead` throws
 * `ERR_HTTP_HEADERS_SENT`.
 *
 * The handler that is re-added is the SAME `server.requestHandler` that was
 * removed, so the websocket upgrade path and the default response are untouched.
 */
export function mountRoutes(
  httpServer: HttpServer,
  fallback: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  routes: HttpRoutes,
): void {
  httpServer.removeAllListeners('request');
  httpServer.on('request', (request, response) => {
    void handle(request, response, routes)
      .then(async (handled) => {
        if (!handled) await fallback(request, response);
      })
      .catch((error: unknown) => {
        // Nothing above this catches: an async listener that rejects is an
        // unhandledRejection, which under Node's default terminates the process.
        console.error('[sync] request failed:', error);
        if (!response.headersSent)
          json(response, 500, { code: 'INTERNAL', message: 'Request failed' });
        else response.end();
      });
  });
}
