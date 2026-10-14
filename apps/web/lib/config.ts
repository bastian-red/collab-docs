/**
 * Every environment variable this app reads, in one module, split by who can see
 * it.
 *
 * **`NEXT_PUBLIC_*` names are inlined into the browser bundle by textual
 * substitution**, which bites in two directions. They must be read as
 * `process.env.NEXT_PUBLIC_X` literally: a computed lookup is not substituted, so
 * the value is defined on the server and `undefined` in the tab, and the bug lives
 * in the half of the app nobody is looking at. And they are baked at build time,
 * which is why `infra/Dockerfile.web` takes them as build ARGs.
 *
 * The server-only names must never reach a component that ships to the browser.
 * `AUTH_SECRET` is the one that matters; it is read by `authSecret()` below, which
 * is only imported from files that begin with `import 'server-only'`.
 *
 * Every read is spelled out literally because `scripts/env-contract.mjs` finds
 * reads by pattern and turbo runs in strict env mode: a name it cannot see is a
 * name that is silently stripped from the process.
 */

/**
 * Where the browser opens its websocket to `apps/sync`.
 *
 * The single address the browser itself connects to (docs/SPECS.md 12.3). A wrong
 * value here produces a page that signs in, lists every document, renders the
 * title, and never shows a word of the body: a provider that cannot connect just
 * retries, and nothing errors.
 */
export const publicSyncUrl = process.env.NEXT_PUBLIC_SYNC_URL ?? 'ws://localhost:4100';

/** Where the server reaches the API. A service name inside compose, localhost on a laptop. */
export const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';

/** Where the server reaches the first sync replica over HTTP: `/health`, diffs, manual versions. */
export const syncBaseUrl = process.env.SYNC_BASE_URL ?? 'http://localhost:4100';

/**
 * The second replica, when one is running.
 *
 * `undefined` means "not running", not "running on 4101". `/status` probes both
 * because one replica green and one red is this product's worst failure (two
 * people typing into documents that no longer reach each other), and a page that
 * assumed a second replica existed would report an outage for the documented
 * single-replica `pnpm dev`.
 */
export const syncBaseUrl2 = process.env.SYNC_BASE_URL_2 || undefined;

/** This app's own origin, for absolute share links. */
export const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000';

/** Reported on `/status`, so two builds are tellable apart. */
export const appVersion = process.env.APP_VERSION ?? '0.0.0';

/**
 * The size ceiling the sync server enforces, so the "document is full" banner
 * quotes the real number rather than one typed into a sentence (docs/DESIGN.md 4).
 */
export const documentMaxBytes = Number(process.env.DOCUMENT_MAX_BYTES ?? 5_242_880);

/**
 * The shared HS256 secret.
 *
 * Asserted here rather than where it is used: a missing secret does not merely
 * break sign-in, it makes every REST call and every socket handshake fail at once,
 * which presents as a document that renders its title and never its text. Failing
 * here turns that into one sentence.
 */
export function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret === undefined || secret.length < 16) {
    throw new Error(
      'AUTH_SECRET must be set and at least 16 characters. Without it the web app cannot mint ' +
        'the service token the API and the sync server both verify.',
    );
  }
  return secret;
}
