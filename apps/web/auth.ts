/**
 * The session, and the one place a password passes through this app.
 *
 * The split with `apps/api` is why this file is short. The API owns the user
 * table, the scrypt hash and the constant-time comparison, and answers
 * `POST /auth/sign-in` with a `SessionUser` or an `INVALID`. This file owns the
 * cookie: it forwards a credential once and keeps the answer.
 *
 * A JWT session, not a database one: a database session would need this app to
 * hold a Postgres connection, and the web tier talks to the API and the sync
 * server and to nothing else (docs/SPECS.md 12.3).
 *
 * `trustHost: true` because the app is reached only on the host it is configured
 * with (`AUTH_URL`). Without it Auth.js refuses to run outside Vercel with a 500
 * and no useful message.
 */
import { sessionUserSchema, signInSchema, type SessionUser } from '@docs/shared';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

import { ApiError, apiFetch } from './lib/api';

/**
 * Auth.js turns anything thrown out of `authorize` into a generic
 * `CredentialsSignin`, so the reason never reaches the browser, which is correct:
 * "no such account" and "wrong password" are one answer to anyone who is not the
 * account holder. Returning `null` produces exactly that.
 */
async function verifyCredentials(raw: unknown): Promise<SessionUser | null> {
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) return null;

  try {
    return await apiFetch(null, '/auth/sign-in', sessionUserSchema, {
      method: 'POST',
      body: parsed.data,
    });
  } catch (error) {
    // A 400 is a wrong password and not worth a log line. Anything else is the API
    // unreachable or off-contract, which whoever reads the logs needs to see: the
    // symptom in the browser is identical, which is exactly why the log matters.
    if (!(error instanceof ApiError) || error.code !== 'INVALID') {
      console.error('[web] sign-in could not be completed:', error);
    }
    return null;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: 'jwt' },
  // Auth.js's own pages are never rendered; an unstyled framework page is a seam.
  pages: { signIn: '/sign-in', error: '/sign-in' },
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: (raw) => verifyCredentials(raw),
    }),
  ],
  callbacks: {
    /**
     * `user` is present only on the sign-in pass. Parsed rather than cast: a
     * response that drifted from the contract produces no session instead of one
     * whose `id` is undefined, and the id is not cosmetic here -- it is the `sub`
     * of every service token and the seed of this person's caret colour.
     */
    jwt({ token, user }) {
      if (!user) return token;
      const parsed = sessionUserSchema.safeParse(user);
      if (!parsed.success) return null;
      token.collab = parsed.data;
      return token;
    },
    session({ session, token }) {
      const parsed = sessionUserSchema.safeParse(token.collab);
      // No user rather than a half-built one; every caller reads a missing user as
      // "signed out", which is the safe reading.
      if (!parsed.success) return { ...session, user: undefined as never };
      return { ...session, user: parsed.data };
    },
  },
});
