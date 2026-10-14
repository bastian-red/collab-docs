/**
 * What must be true before `NestFactory.create` is called.
 *
 * The same property `apps/sync/src/config.ts` has: **every reason this process
 * will not work is discovered before it is listening.** An API that binds :4000
 * and then fails on the first share link looks healthy to a container runtime,
 * gets traffic, and produces a user-facing error for an operational fact that was
 * already true when the process started.
 *
 * Called from `main.ts` before the Nest application exists, so a failure here is
 * a plain sentence on stderr rather than a framework stack with the one useful
 * line buried in the middle of it.
 */
import type { ApiConfig } from './config';

export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootError';
  }
}

/** The longest TTL `createShareLinkSchema` will accept, in hours. One year. */
export const SHARE_LINK_TTL_MAX_HOURS = 8760;

export function assertConsistent(config: ApiConfig): void {
  // Auth is the credential-stuffing surface, so its budget is deliberately far
  // below the general one. A configuration where auth is the looser of the two
  // is almost certainly a copy-paste, and it is the exact mistake that turns a
  // rate limit into decoration. `.env.example` says so beside both names.
  if (config.rateLimitAuth >= config.rateLimitGlobal) {
    throw new BootError(
      `RATE_LIMIT_AUTH (${String(config.rateLimitAuth)}) must be below RATE_LIMIT_GLOBAL ` +
        `(${String(config.rateLimitGlobal)}). Auth is the credential-stuffing surface; a budget ` +
        'at or above the general one is not a limit.',
    );
  }

  // The default has to be a value the contract would also accept from a client.
  // If it is not, every share link created without an explicit expiry is refused
  // by the same schema that validated the request -- a 400 on the happy path,
  // caused by a number in .env, with nothing in the message pointing at it.
  if (config.shareLinkTtlHours > SHARE_LINK_TTL_MAX_HOURS) {
    throw new BootError(
      `SHARE_LINK_TTL_HOURS (${String(config.shareLinkTtlHours)}) is above the ` +
        `${String(SHARE_LINK_TTL_MAX_HOURS)}-hour ceiling the share contract accepts, so every ` +
        'link created without an explicit expiry would be refused.',
    );
  }

  // A page size of one is technically a page size. A page size in the thousands
  // is a list endpoint that materialises every document a person can see, plus
  // its members, on every sidebar render.
  if (config.documentListPageSize > 200) {
    throw new BootError(
      `DOCUMENT_LIST_PAGE_SIZE (${String(config.documentListPageSize)}) is above 200. The list ` +
        'endpoint loads each row with its members, so a page this large is one query per ' +
        'document per sidebar render.',
    );
  }
}

export function assertBootable(config: ApiConfig): void {
  assertConsistent(config);
}
