/**
 * The service-token guard, and the session it puts on the request.
 *
 * **Default closed.** Registered globally in `app.module.ts`, so a route added
 * next year is authenticated unless somebody writes `@Public()` on it. The
 * opposite arrangement -- a guard applied per controller -- fails silently in the
 * one direction that matters: a forgotten decorator is an open endpoint, and
 * nothing about the code looks wrong.
 *
 * The token is the same short-lived HS256 service token the socket handshake
 * carries, minted by the web app for the signed-in session. One secret, three
 * processes: web mints, this API verifies, `apps/sync` verifies. That is why
 * `scripts/dev.sh` refuses to start without `AUTH_SECRET`.
 *
 * The verifier's `reason` (`expired` versus `signature`) goes to the log and
 * never to the response, for the same reason `apps/sync`'s handshake keeps it
 * back (docs/SPECS.md 4.1 step 5): telling a caller which half of the token to
 * keep working on is a hint nobody legitimate needs.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readBearer, verifyServiceToken } from '@docs/shared/server';
import type { SessionUser } from '@docs/shared';
import type { Request } from 'express';

import { API_CONFIG, type ApiConfig } from '../config/config';

export const IS_PUBLIC = 'collab:isPublic';

/**
 * The escape hatch, named for what it means rather than for what it disables.
 *
 * Three routes carry it: sign up, sign in, and `/health`. Health is public on
 * purpose -- a probe that needs a credential is a probe a container runtime
 * cannot run -- and it reports dependency status, never data.
 */
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC, true);

/** What the token proved, hung off the request by the guard. */
export interface RequestWithUser extends Request {
  user?: SessionUser;
}

/**
 * The decision, with no framework in it.
 *
 * Separated from `canActivate` so the rule is testable without an
 * `ExecutionContext`, a `Reflector` and an express request. It returns the user
 * or a refusal reason; the guard turns the refusal into a 401 and writes the
 * reason to the log.
 */
export type AuthOutcome =
  | { readonly ok: true; readonly user: SessionUser }
  | { readonly ok: false; readonly reason: string };

export function authoriseRequest(
  authorization: string | string[] | undefined,
  secret: string,
): AuthOutcome {
  const token = readBearer(authorization);
  if (token === null) return { ok: false, reason: 'absent' };

  const result = verifyServiceToken(token, secret);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, user: result.user };
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Handler before class, so a `@Public()` method inside an otherwise
    // authenticated controller works -- which is what the auth controller needs.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const outcome = authoriseRequest(request.headers.authorization, this.config.authSecret);

    if (!outcome.ok) {
      if (outcome.reason !== 'absent') console.warn(`[api] token rejected: ${outcome.reason}`);
      throw new UnauthorizedException('That token was not accepted.');
    }

    request.user = outcome.user;
    return true;
  }
}

/**
 * The signed-in user, as a parameter.
 *
 * Throws rather than returning undefined when the guard did not run. A handler
 * that read `user.id` off an unauthenticated request would scope its query by
 * `undefined`, and in Prisma `undefined` is not "no rows", it is "no filter":
 * the query would return somebody else's document.
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<RequestWithUser>();
  if (!request.user) {
    throw new UnauthorizedException('This endpoint needs a service token.');
  }
  return request.user;
});
