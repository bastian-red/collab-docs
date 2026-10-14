/**
 * Classifying a database error, for both Prisma vocabularies.
 *
 * Pure functions over an error shape, so they are unit tested here without a
 * database. The constraints themselves are exercised by the integration lane,
 * which has one.
 */
import {
  UNIQUE_INDEX_COLUMNS,
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  PRISMA_FOREIGN_KEY_VIOLATION,
  PRISMA_NOT_FOUND,
  PRISMA_UNIQUE_VIOLATION,
} from './constraints';

/**
 * Read a `code` off an unknown error without assuming a class.
 *
 * Deliberately structural rather than `instanceof PrismaClientKnownRequestError`:
 * the generated client is emitted into the package, and an `instanceof` against
 * a class from a second copy of that client -- which a `pnpm deploy --prod`
 * layer can produce -- is false for an error that is otherwise identical.
 */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

/**
 * Whether the error names a specific constraint.
 *
 * The typed client puts it in `meta.target`; a raw query puts it only in the
 * message text. Reading both is the point -- see the note in constraints.ts
 * about the bug that reading only one produces.
 */
export function violatedConstraint(error: unknown, name: string): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const meta = (error as { meta?: { target?: unknown; constraint?: unknown } }).meta;
  if (meta) {
    if (meta.constraint === name) return true;
    const target = meta.target;
    if (typeof target === 'string' && target === name) return true;
    if (Array.isArray(target) && target.includes(name)) return true;
  }

  return messageOf(error).includes(name);
}

/**
 * Whether this error is THAT unique index, whichever client raised it.
 *
 * The one function a catch block should use. `violatedConstraint` alone is not
 * enough and reading its own doc comment does not reveal why: the typed client
 * reports COLUMNS in `meta.target` and never the index name, while `$queryRaw`
 * reports the name in the message and nothing in `meta`. A predicate that reads
 * only one of them is right for one client and silently false for the other --
 * and "silently false" here means a duplicate sign-up answering 500 instead of
 * 409, or a version-number race that never retries because the retry condition
 * never matches.
 *
 * The column list is compared as a SET. Prisma reports the index's columns in
 * the order the index declares them, but relying on that would make this
 * predicate depend on a detail nothing pins.
 */
export function violatedUniqueIndex(error: unknown, name: string): boolean {
  if (!isUniqueViolation(error)) return false;
  // The raw path: the name is in the message text.
  if (violatedConstraint(error, name)) return true;

  const columns = UNIQUE_INDEX_COLUMNS[name];
  if (columns === undefined) return false;

  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (!Array.isArray(target)) return false;

  const reported = new Set(target.filter((value): value is string => typeof value === 'string'));
  return reported.size === columns.length && columns.every((column) => reported.has(column));
}

export function isUniqueViolation(error: unknown): boolean {
  const code = codeOf(error);
  if (code === PRISMA_UNIQUE_VIOLATION || code === PG_UNIQUE_VIOLATION) return true;
  // A raw query through the typed client can arrive as
  // PrismaClientUnknownRequestError, whose `code` is undefined and whose
  // SQLSTATE is only in the message. project004 lost an afternoon to exactly
  // this shape.
  return code === undefined && messageOf(error).includes(PG_UNIQUE_VIOLATION);
}

export function isCheckViolation(error: unknown): boolean {
  const code = codeOf(error);
  if (code === PG_CHECK_VIOLATION) return true;
  return code === undefined && messageOf(error).includes(PG_CHECK_VIOLATION);
}

export function isForeignKeyViolation(error: unknown): boolean {
  const code = codeOf(error);
  if (code === PRISMA_FOREIGN_KEY_VIOLATION || code === PG_FOREIGN_KEY_VIOLATION) return true;
  return code === undefined && messageOf(error).includes(PG_FOREIGN_KEY_VIOLATION);
}

export function isNotFound(error: unknown): boolean {
  return codeOf(error) === PRISMA_NOT_FOUND;
}
