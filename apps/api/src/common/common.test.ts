import { DomainError, ERROR_CODES, HTTP_STATUS } from '@docs/shared';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DomainErrorFilter } from './domain-error.filter';
import { ZodPipe, fieldsOf, invalidBody } from './zod.pipe';
import { authoriseRequest } from './session.guard';
import { mintServiceToken } from '@docs/shared/server';

const SECRET = 'a-secret-at-least-sixteen-characters';
const USER = { id: 'clq1234567890abcdefghij', email: 'ada@example.com', name: 'Ada' };

describe('authoriseRequest', () => {
  it('accepts a bearer token this secret minted', () => {
    const outcome = authoriseRequest(`Bearer ${mintServiceToken(USER, SECRET)}`, SECRET);
    expect(outcome).toEqual({ ok: true, user: USER });
  });

  it('refuses an absent header without a verifier reason', () => {
    // `absent` and not `malformed`: nothing was presented, so there is nothing to
    // log about a token. The guard uses this to stay quiet on the ordinary case
    // of a signed-out request.
    expect(authoriseRequest(undefined, SECRET)).toEqual({ ok: false, reason: 'absent' });
  });

  it('refuses a token minted with another secret', () => {
    const token = mintServiceToken(USER, 'a-different-secret-entirely-ok');
    expect(authoriseRequest(`Bearer ${token}`, SECRET)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses an expired token', () => {
    const token = mintServiceToken(USER, SECRET, -1);
    expect(authoriseRequest(`Bearer ${token}`, SECRET)).toEqual({ ok: false, reason: 'expired' });
  });

  it('reads the scheme case-insensitively, per RFC 7235', () => {
    const token = mintServiceToken(USER, SECRET);
    expect(authoriseRequest(`bearer ${token}`, SECRET).ok).toBe(true);
  });
});

describe('ZodPipe', () => {
  const schema = z.object({ title: z.string().min(3), folderId: z.string().nullable() });

  it('returns the parsed value', () => {
    const pipe = new ZodPipe(schema);
    expect(pipe.transform({ title: 'Notes', folderId: null })).toEqual({
      title: 'Notes',
      folderId: null,
    });
  });

  /**
   * The property this pipe exists for. Zod quotes the offending input into its
   * message for a length rule, and in this product that input is a document
   * title or a password.
   */
  it('never puts the rejected value in the response', () => {
    const pipe = new ZodPipe(schema);
    let thrown: unknown;
    try {
      // A value that cannot appear in the fixed message by accident, so the
      // assertion below is about the value and not about a substring collision.
      pipe.transform({ title: 'zq', folderId: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = JSON.stringify((thrown as BadRequestException).getResponse());
    expect(body).not.toContain('zq');
    expect(JSON.parse(body)).toEqual({
      code: 'INVALID',
      message: 'That request was not in a shape this server accepts.',
      fields: ['title'],
    });
  });

  it('de-duplicates field names and drops the empty path', () => {
    // An empty path is a whole body of the wrong type. Joining it yields '', and
    // without the filter the client would be told to highlight a field called
    // "undefined".
    expect(fieldsOf([{ path: [] }, { path: ['a'] }, { path: ['a'] }, { path: ['b', 0] }])).toEqual([
      'a',
      'b.0',
    ]);
  });

  it('reports no fields at all for a body of the wrong type', () => {
    const pipe = new ZodPipe(schema);
    try {
      pipe.transform('not an object');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toEqual(invalidBody([]));
    }
  });
});

describe('DomainErrorFilter', () => {
  function harness(): {
    filter: DomainErrorFilter;
    host: never;
    sent: { status?: number; body?: unknown };
  } {
    const sent: { status?: number; body?: unknown } = {};
    const response = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
      },
    };
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as never;
    return { filter: new DomainErrorFilter(), host, sent };
  }

  /**
   * Exhaustive over the shared vocabulary rather than by example. `HTTP_STATUS`
   * is a `Record<ErrorCode, number>`, so a new code fails the compile; this
   * asserts the filter actually reaches it for every one of them.
   */
  it.each(ERROR_CODES)('maps %s', (code) => {
    const { filter, host, sent } = harness();
    filter.catch(new DomainError(code, 'nope'), host);
    expect(sent.status).toBe(HTTP_STATUS[code]);
    expect(sent.body).toEqual({ code, message: 'nope' });
  });

  // The shared table and Nest's own constants have to name the same numbers, or
  // a handler that throws `NotFoundException` and one that throws
  // `DomainError('NOT_FOUND')` answer differently for the same fact.
  it("agrees with Nest's status constants", () => {
    expect(HTTP_STATUS.UNAUTHENTICATED).toBe(HttpStatus.UNAUTHORIZED);
    expect(HTTP_STATUS.NOT_FOUND).toBe(HttpStatus.NOT_FOUND);
    expect(HTTP_STATUS.FORBIDDEN).toBe(HttpStatus.FORBIDDEN);
    expect(HTTP_STATUS.GONE).toBe(HttpStatus.GONE);
    expect(HTTP_STATUS.TOO_LARGE).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(HTTP_STATUS.CONFLICT).toBe(HttpStatus.CONFLICT);
    expect(HTTP_STATUS.INVALID).toBe(HttpStatus.BAD_REQUEST);
  });

  it('passes a ZodPipe body through with its field list intact', () => {
    const { filter, host, sent } = harness();
    filter.catch(new BadRequestException(invalidBody(['title'])), host);
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual(invalidBody(['title']));
  });

  /**
   * The exceptions Nest raises itself carry `{ message, error, statusCode }` and
   * no `code`. Without `bodyFor` giving them one from the status, "every
   * response carries a code" would be false of the 401 a client meets first.
   */
  it('gives a framework exception a code from its status', () => {
    const { filter, host, sent } = harness();
    filter.catch(new UnauthorizedException('That token was not accepted.'), host);
    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'That token was not accepted.',
    });
  });

  it('falls back for a status no code claims', () => {
    const { filter, host, sent } = harness();
    filter.catch(new HttpException('Slow down', 429), host);
    expect(sent.status).toBe(429);
    expect(sent.body).toEqual({ code: 'INVALID', message: 'Slow down' });
  });

  /**
   * An unclassified error's text could be a connection string, a stack, or half a
   * document. It is logged and a fixed sentence goes on the wire.
   */
  it('never puts an unmapped error message on the wire', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { filter, host, sent } = harness();
    filter.catch(new Error('postgresql://collab:hunter2@localhost:5440/collab'), host);
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ code: 'INTERNAL', message: 'Something went wrong on the server.' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
