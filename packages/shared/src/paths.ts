/**
 * The URLs three processes have to agree on.
 *
 * Same reasoning as `rooms.ts`: a drifted path is silently successful. The API
 * hands back a share URL, somebody pastes it into a chat, and the web app answers
 * 404 for a link that is perfectly valid -- which looks like a broken share
 * feature and is a string mismatch. So the strings are computed here and nowhere
 * else, and both sides import them.
 */

/** The query parameter a share token travels in, on the page URL and on the socket URL. */
export const SHARE_PARAM = 'share';

/** Where a document is read and edited. */
export function documentPath(documentId: string): string {
  return `/d/${documentId}`;
}

/**
 * The absolute URL for a share link.
 *
 * Built with `URL` rather than by concatenation, so a base with a trailing slash
 * and one without produce the same result. `APP_BASE_URL=http://localhost:3000/`
 * is the kind of thing somebody writes once, and string concatenation turns it
 * into a `//d/...` path that resolves to a different host.
 */
export function shareLinkUrl(appBaseUrl: string, documentId: string, token: string): string {
  const url = new URL(documentPath(documentId), appBaseUrl);
  url.searchParams.set(SHARE_PARAM, token);
  return url.toString();
}
