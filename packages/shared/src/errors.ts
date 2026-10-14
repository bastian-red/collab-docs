/**
 * One error vocabulary, crossing every boundary.
 *
 * `apps/api`'s DomainErrorFilter maps these to HTTP statuses; `apps/sync`'s
 * handshake maps them to close reasons. That is the whole reason one function in
 * `services/doc-access` can serve both a REST call and a socket connection
 * without either framework leaking into it.
 *
 * Clients match on `code`, never on prose. The message is for a person.
 */

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID',
  'CONFLICT',
  'TOO_LARGE',
  'GONE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
    // Without this, `instanceof DomainError` is false when the class is compiled
    // to ES5-era output and the prototype chain is rebuilt by the constructor.
    // The target here is ES2022 so it holds anyway; it is one line of insurance
    // against a tsconfig change that would otherwise break every catch block
    // silently rather than at compile time.
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * The HTTP status each code answers with.
 *
 * Here rather than in either server, because both of them answer HTTP:
 * `apps/api`'s `DomainErrorFilter` and `apps/sync`'s `/documents/:id/diff`. Two
 * copies of this table would agree until somebody added a code, and the one that
 * was forgotten would answer 500 for a client mistake.
 *
 * `Record<ErrorCode, number>` is the enforcement: adding a code to `ERROR_CODES`
 * without adding it here does not compile.
 *
 * Two of the six are not the obvious status and are the reason the table is worth
 * reading:
 *
 * - `NOT_FOUND` (404) is also what "you have no access to this document"
 *   answers. A caller who is not on a document must not be able to tell one that
 *   exists from one that does not; "403 here, 404 there" is a directory listing
 *   for anybody willing to iterate. `services/doc-access`'s `requireAction` is
 *   where that choice is made.
 * - `GONE` (410) is the single answer a share link gets for all four ways of
 *   being no good -- unknown, revoked, expired, presented for another document --
 *   because distinguishing them tells a guesser which tokens were real.
 */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  // Nobody proved who they are. Distinct from FORBIDDEN, which is somebody known
  // whose role is too weak, and the distinction is the one a client acts on: 401
  // means get a new token, 403 means stop asking.
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID: 400,
  CONFLICT: 409,
  TOO_LARGE: 413,
  GONE: 410,
});

/** The status for a code, or 500 for a string that is not one. */
export function httpStatusForCode(code: string): number {
  return Object.prototype.hasOwnProperty.call(HTTP_STATUS, code)
    ? HTTP_STATUS[code as ErrorCode]
    : 500;
}

/**
 * The inverse: a status back to the code that produces it, or null.
 *
 * Built by inverting `HTTP_STATUS` rather than written out, so the two can never
 * disagree. It exists for exactly one caller -- `apps/api`'s error filter, which
 * has to give a `code` to the exceptions Nest raises on its own (`401
 * Unauthorized`, `404 Not Found`), whose bodies carry a `statusCode` and no code
 * at all. Without it, "every response carries a code" would be true of every
 * response the application throws and false of the ones the framework throws --
 * and a 401 is the first one a client meets.
 */
const CODE_BY_STATUS: ReadonlyMap<number, ErrorCode> = new Map(
  ERROR_CODES.map((code) => [HTTP_STATUS[code], code] as const),
);

export function codeForHttpStatus(status: number): ErrorCode | null {
  return CODE_BY_STATUS.get(status) ?? null;
}
