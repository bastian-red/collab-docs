/**
 * Sign up and sign in.
 *
 * This API holds no session. It answers "are these credentials right, and who is
 * this" and nothing more; the web app puts the answer in an Auth.js session and
 * mints the short-lived service token that every other call and every socket
 * handshake carries. That is why neither this service nor the guard touches a
 * session table (docs/SPECS.md 4.1).
 */
import { Injectable } from '@nestjs/common';
import { USER_EMAIL_UNIQUE, violatedUniqueIndex } from '@docs/db';
import { DomainError, type SessionUser } from '@docs/shared';
import { hashPassword, verifyPassword } from '@docs/shared/server';

import { PrismaService } from '../infra/prisma.service';

/**
 * A stored hash of a password nobody has, used only to burn the same scrypt time
 * for an unknown email as for a known one.
 *
 * Without it, sign-in for an address that exists is measurably slower than for
 * one that does not, because only the first runs scrypt. That difference is a
 * user-enumeration oracle that needs no error message to read: it is visible in
 * the response time, at scale, through any amount of noise.
 *
 * Computed once at module load rather than per request, because computing it per
 * request would double the cost of every failed sign-in.
 */
const DECOY_HASH = hashPassword('decoy-password-for-constant-time-sign-in');

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async signUp(input: { email: string; name: string; password: string }): Promise<SessionUser> {
    try {
      const user = await this.prisma.client.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash: hashPassword(input.password),
        },
        select: { id: true, email: true, name: true },
      });
      return user;
    } catch (error) {
      // Never on the message text: Postgres owns the wording and changes it
      // between minor versions. `violatedUniqueIndex` and not the name alone,
      // because the typed client reports `meta.target: ["email"]` and never
      // `users_email_key` -- a name-only check made this branch dead code and
      // every duplicate sign-up a 500. The integration lane is what found it.
      if (violatedUniqueIndex(error, USER_EMAIL_UNIQUE)) {
        throw new DomainError('CONFLICT', 'That email address is already registered.');
      }
      throw error;
    }
  }

  /**
   * Sign in, with one answer for both ways of failing.
   *
   * "No such user" and "wrong password" are the same `INVALID`, with the same
   * sentence, after the same amount of work. Distinguishing them turns the
   * sign-in form into a list of who has an account here.
   */
  async signIn(input: { email: string; password: string }): Promise<SessionUser> {
    const row = await this.prisma.client.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, name: true, passwordHash: true },
    });

    const stored = row?.passwordHash ?? DECOY_HASH;
    const correct = verifyPassword(input.password, stored);

    if (row === null || !correct) {
      throw new DomainError('INVALID', 'That email address and password do not match.');
    }
    return { id: row.id, email: row.email, name: row.name };
  }
}
