/**
 * Share-link tokens.
 *
 * Not a JWT and not a cuid. A share link is a bearer credential that lives in a
 * URL somebody pastes into a chat, so it is 32 bytes from the system CSPRNG and
 * nothing else: no structure to guess at, no expiry encoded in the token itself
 * (the expiry is a column, so revoking one is an UPDATE rather than a
 * blocklist).
 *
 * base64url rather than hex: same entropy in two thirds of the characters, and
 * no character that needs escaping in a URL.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

export function mintShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Compare two tokens without leaking, through timing, how many leading
 * characters matched.
 *
 * The database lookup itself is not constant time and cannot be, so this is not
 * the whole story; it exists for the places that compare a supplied token
 * against one already loaded. Length is checked first because `timingSafeEqual`
 * throws on a length mismatch, and a throw is a far louder timing signal than
 * the comparison it was protecting.
 */
export function shareTokensMatch(supplied: string, stored: string): boolean {
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
