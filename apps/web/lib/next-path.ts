/**
 * Where to send somebody after they sign in.
 *
 * The share-link flow needs this: a signed-out reader opens `/d/abc?share=xyz`, is
 * sent to sign in, and must land back on that exact URL. Taking the target from a
 * query parameter is an open redirect unless the value is proved to be a path on
 * this origin, and the ways a value that looks like a path is not one are the
 * whole content of this function:
 *
 * - `//evil.example/x` is protocol-relative: a browser reads it as another host.
 * - `/\evil.example` is normalised by browsers to `//evil.example`.
 * - `https://evil.example` and `javascript:...` are absolute.
 * - A control character or a newline can split a header.
 *
 * Anything that is not plainly a same-origin path falls back to the list, which
 * is a harmless place to land and never a place an attacker chose.
 */
export const DEFAULT_AFTER_SIGN_IN = '/';

export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000)
    return DEFAULT_AFTER_SIGN_IN;
  if (!raw.startsWith('/')) return DEFAULT_AFTER_SIGN_IN;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_AFTER_SIGN_IN;
  // eslint-disable-next-line no-control-regex -- the control range is the point.
  if (/[\u0000-\u001f\u007f\\]/u.test(raw)) return DEFAULT_AFTER_SIGN_IN;

  // The final word goes to the URL parser itself: resolve against a placeholder
  // origin and require the origin to survive. Any trick above that slipped past
  // the string checks changes the origin here.
  const base = 'https://same-origin.invalid';
  let resolved: URL;
  try {
    resolved = new URL(raw, base);
  } catch {
    return DEFAULT_AFTER_SIGN_IN;
  }
  if (resolved.origin !== base) return DEFAULT_AFTER_SIGN_IN;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
