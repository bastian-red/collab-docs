/**
 * The token three processes agree on.
 *
 * The web app mints it from an Auth.js session; `apps/api` and `apps/sync` each
 * verify it with the same `AUTH_SECRET`. Neither of them holds a session: no
 * cookie, no session table, no database round trip on the auth path, which is
 * what lets both scale to N replicas.
 *
 * Short-lived on purpose. Two minutes is long enough for a connection attempt
 * and short enough that a token captured out of a log is worthless by the time
 * anybody reads it. That is also why the sync provider is given the CALLBACK
 * form of `token` rather than a value: a value goes stale on the first reconnect
 * past its life, and for a laptop that slept, reconnecting is the normal case.
 */
import jwt from 'jsonwebtoken';

import { sessionUserSchema, type SessionUser } from '../contracts/auth';

export const SERVICE_TOKEN_TTL_SECONDS = 120;

export type VerifyFailure = 'expired' | 'signature' | 'malformed' | 'claims';

export type VerifyResult = { ok: true; user: SessionUser } | { ok: false; reason: VerifyFailure };

export function mintServiceToken(
  user: SessionUser,
  secret: string,
  ttlSeconds: number = SERVICE_TOKEN_TTL_SECONDS,
): string {
  return jwt.sign({ email: user.email, name: user.name }, secret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: ttlSeconds,
  });
}

/**
 * Verify, returning a result rather than throwing, so Nest and Hocuspocus each
 * wrap it in their own kind of rejection.
 *
 * `algorithms: ['HS256']` pinned is the whole security boundary. Without it
 * `jsonwebtoken` will honour the `alg` header on the token itself, and a forged
 * token claiming `alg: none` -- or `alg: RS256` with the HMAC secret used as an
 * RSA public key -- verifies.
 *
 * The claims are PARSED, not cast. A token whose `sub` is missing would
 * otherwise produce a user whose `id` is `undefined`, and in Prisma `undefined`
 * is not "no rows", it is "no filter": the first query would return somebody
 * else's document.
 */
export function verifyServiceToken(token: string, secret: string): VerifyResult {
  let claims: unknown;
  try {
    claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) return { ok: false, reason: 'expired' };
    if (error instanceof jwt.JsonWebTokenError) return { ok: false, reason: 'signature' };
    return { ok: false, reason: 'malformed' };
  }

  if (typeof claims !== 'object' || claims === null) return { ok: false, reason: 'claims' };

  const { sub, email, name } = claims as Record<string, unknown>;
  const parsed = sessionUserSchema.safeParse({ id: sub, email, name });
  if (!parsed.success) return { ok: false, reason: 'claims' };

  return { ok: true, user: parsed.data };
}

/** `Authorization: Bearer <token>`, or null. Case-insensitive per RFC 7235. */
export function readBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = /^bearer\s+(\S+)$/iu.exec(value.trim());
  return match?.[1] ?? null;
}
