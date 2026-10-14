/**
 * Shared plumbing for the integration lane.
 *
 * Everything here talks to the real thing: the two sync replicas
 * `scripts/integration.sh` started, the real Postgres, the real Redis. Nothing
 * is faked, because the failures this lane exists to catch -- a Redis relay that
 * is not wired, a read-only connection that is not read-only, a `seq` that
 * skips -- are all failures of the wiring rather than of the logic.
 */
import { createPrismaClient, type PrismaClient } from '@docs/db';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { SessionUser } from '@docs/shared';
import { mintServiceToken } from '@docs/shared/server';
import WebSocket from 'ws';
import * as Y from 'yjs';

export const REPLICA_ONE = process.env.SYNC_BASE_URL ?? 'http://localhost:4100';
export const REPLICA_TWO = process.env.SYNC_BASE_URL_2 ?? 'http://localhost:4101';

export const AUTH_SECRET = required('AUTH_SECRET', process.env.AUTH_SECRET);
export const DATABASE_URL = required('DATABASE_URL', process.env.DATABASE_URL);

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run this through ./scripts/integration.sh.`);
  }
  return value;
}

export function socketUrl(base: string): string {
  return base.replace(/^http/u, 'ws');
}

export function prisma(): PrismaClient {
  return createPrismaClient({ url: DATABASE_URL });
}

export interface Connected {
  readonly provider: HocuspocusProvider;
  readonly doc: Y.Doc;
  /** Set when the server refused the handshake, which is a close and not an error event. */
  readonly refused: () => boolean;
  destroy(): void;
}

/**
 * Open a provider against one replica.
 *
 * The socket is constructed explicitly rather than letting `HocuspocusProvider`
 * make one from a `url`, because `WebSocketPolyfill` and `maxAttempts` live on
 * the WEBSOCKET configuration in `@hocuspocus/provider@4.6.0` and the provider's
 * own configuration accepts only `url` and `preserveTrailingSlash` from that
 * side. Checked against the shipped `index.d.ts`, not assumed.
 *
 * `maxAttempts: 1` matters for the refusal tests: the default retries with
 * backoff forever, so "the server refused me" would present as a test that hangs
 * until its timeout rather than as a refusal.
 *
 * The share token rides in the URL's query string, which is what the server
 * reads as `requestParameters`. v4.6.0 has no `parameters` option on either
 * configuration -- also checked, not assumed.
 *
 * The token is minted per connection attempt, never cached, for the reason
 * docs/SPECS.md 4.1 gives: a cached one works for two minutes and then fails for
 * the rest of the run, and that failure looks like flakiness.
 *
 * `clientID` is pinned by the caller. A Y.Doc assigns itself a random one, which
 * is what breaks ties between concurrent inserts, so an unpinned pair makes a
 * convergence failure unreproducible.
 */
export async function connect(options: {
  base: string;
  documentId: string;
  user: SessionUser;
  clientId: number;
  shareToken?: string;
  expectFailure?: boolean;
  /** Overrides AUTH_SECRET, so a wrong-signature refusal can be provoked. */
  secret?: string;
}): Promise<Connected> {
  const doc = new Y.Doc();
  doc.clientID = options.clientId;

  const url =
    options.shareToken === undefined
      ? socketUrl(options.base)
      : `${socketUrl(options.base)}?share=${encodeURIComponent(options.shareToken)}`;

  const socket = new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: WebSocket,
    maxAttempts: 1,
  });

  let refused = false;
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: options.documentId,
    document: doc,
    token: () => mintServiceToken(options.user, options.secret ?? AUTH_SECRET),
    onAuthenticationFailed: () => {
      refused = true;
    },
  });

  // **Required when `websocketProvider` is passed explicitly.** Read out of
  // `hocuspocus-provider.esm.js:689`: the provider only attaches itself when it
  // constructed its own socket (`manageSocket`), and passing one in sets that
  // false. Without this call nothing connects, no status event fires, and the
  // symptom is a test that waits ten seconds for a sync that was never started.
  provider.attach();

  if (options.expectFailure === true) {
    await waitFor(() => refused, `a refusal from ${options.base}`);
  } else {
    await waitFor(() => provider.isSynced, `sync with ${options.base}`);
  }

  return {
    provider,
    doc,
    refused: () => refused,
    destroy: () => {
      provider.detach();
      provider.destroy();
      socket.destroy();
      doc.destroy();
    },
  };
}

/** Poll until a condition holds, or fail with what was being waited for. */
export async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * The same, for a condition that has to ask the database.
 *
 * Separate from `waitFor` rather than accepting `boolean | Promise<boolean>`,
 * because a Promise is always truthy: passing an async predicate to the
 * synchronous version returns on the first tick and the test passes without ever
 * checking anything. That is not hypothetical -- it is what the first draft of
 * the seq test did.
 */
export async function waitForAsync(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  const suffix = lastError === undefined ? '' : ` (last error: ${String(lastError)})`;
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}${suffix}`);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export const FRAGMENT = 'default';

/** Append a paragraph, the way TipTap's schema shapes a document. */
export function appendParagraph(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment(FRAGMENT);
  const element = new Y.XmlElement('paragraph');
  Y.transact(doc, () => {
    fragment.insert(fragment.length, [element]);
    element.insert(0, [new Y.XmlText(text)]);
  });
}

export function textOf(doc: Y.Doc): string {
  return doc
    .getXmlFragment(FRAGMENT)
    .toArray()
    .map((node) => node.toString().replace(/<[^>]*>/gu, ''))
    .join('\n');
}
