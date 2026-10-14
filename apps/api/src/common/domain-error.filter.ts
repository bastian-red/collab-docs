/**
 * `DomainError` to an HTTP status, in one place.
 *
 * `services/doc-access` and `services/versioning` throw typed codes rather than
 * framework exceptions, which is what lets one function serve a REST call and a
 * socket handshake (docs/SPECS.md 4.5).
 *
 * The code-to-status table itself is **not** here. It is `HTTP_STATUS` in
 * `@docs/shared`, because both servers answer HTTP -- this filter and
 * `apps/sync/src/http.ts`'s diff endpoint -- and two copies of that table would
 * agree until somebody added a code. What this file owns is the rest: which
 * exceptions get mapped at all, and what a response body looks like.
 *
 * Every response carries `code`, so a client never has to match on prose. The
 * first time somebody improves the wording, a client that matched on it breaks.
 */
import { DomainError, HTTP_STATUS, codeForHttpStatus } from '@docs/shared';
import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      response
        .status(HTTP_STATUS[exception.code])
        .json({ code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(bodyFor(exception));
      return;
    }

    // Anything unmapped. The message is logged and a fixed sentence is sent: an
    // unclassified error is by definition one nobody has read, so its text could
    // be a connection string or half a document.
    console.error('[api] unhandled exception', exception);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ code: 'INTERNAL', message: 'Something went wrong on the server.' });
  }
}

/**
 * A response body for an exception Nest raised on its own.
 *
 * Two shapes arrive here and only one of them is already right:
 *
 * - `ZodPipe` throws `BadRequestException(invalidBody(...))`, whose body is an
 *   object that already carries `code` and `fields`. It is passed through
 *   unchanged, which is what keeps the field list on a 400.
 * - Everything Nest raises itself -- `UnauthorizedException` from the guard,
 *   `NotFoundException` for an unrouted path -- has a body of
 *   `{ message, error, statusCode }` and **no `code`**. Measured, not assumed:
 *   `new UnauthorizedException('...').getResponse()` is
 *   `{"message":"...","error":"Unauthorized","statusCode":401}`.
 *
 * The second shape is given a code from its status, by inverting the same table
 * the forward direction uses.
 */
function bodyFor(exception: HttpException): unknown {
  const body = exception.getResponse();
  if (typeof body === 'object' && body !== null && 'code' in body) return body;

  const status = exception.getStatus();
  return {
    code: codeForHttpStatus(status) ?? (status >= 500 ? 'INTERNAL' : 'INVALID'),
    // `exception.message`, not the body's: for a string body they are the same,
    // and for an object body Nest has already copied it there.
    message: exception.message,
  };
}
