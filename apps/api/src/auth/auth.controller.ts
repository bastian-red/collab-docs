/**
 * `/auth`: the only two routes on this API that do not need a token.
 *
 * Both carry `@Throttle({ auth: {} })`, which selects the named budget from
 * `app.module.ts` -- an order of magnitude below the general one, because this is
 * the credential-stuffing surface. `assertConsistent` refuses to boot if the two
 * numbers are the wrong way round.
 */
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { signInSchema, signUpSchema, type SessionUser } from '@docs/shared';
import type { z } from 'zod';

import { AuthService } from './auth.service';
import { Public } from '../common/session.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ auth: {} })
  @Post('sign-up')
  signUp(
    @Body(new ZodPipe(signUpSchema)) input: z.infer<typeof signUpSchema>,
  ): Promise<SessionUser> {
    return this.auth.signUp(input);
  }

  /**
   * 200, not 201. Signing in creates nothing; the session is the web app's and
   * lives in a cookie this process never sees.
   */
  @Public()
  @Throttle({ auth: {} })
  @HttpCode(HttpStatus.OK)
  @Post('sign-in')
  signIn(
    @Body(new ZodPipe(signInSchema)) input: z.infer<typeof signInSchema>,
  ): Promise<SessionUser> {
    return this.auth.signIn(input);
  }
}
