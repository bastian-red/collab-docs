/**
 * Shared plumbing for the API's integration lane.
 *
 * The Nest application is built from the real `AppModule` and listens on an
 * ephemeral port, so every request below travels the whole stack: the throttler
 * guard, the session guard, the pipes, the filter, Prisma, Postgres. Nothing is
 * mocked, because everything this lane exists to catch -- a guard that is not
 * default-closed, an access check that forgets `deleted_at`, an ownership
 * transfer that is not atomic -- is a failure of the wiring rather than of a pure
 * function, and the pure functions already have their own tests.
 */
import { createPrismaClient, type PrismaClient } from '@docs/db';
import type { SessionUser } from '@docs/shared';
import { mintServiceToken } from '@docs/shared/server';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';

export const AUTH_SECRET = required('AUTH_SECRET', process.env.AUTH_SECRET);
export const DATABASE_URL = required('DATABASE_URL', process.env.DATABASE_URL);

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run this through ./scripts/integration.sh.`);
  }
  return value;
}

export interface Harness {
  readonly base: string;
  readonly db: PrismaClient;
  close(): Promise<void>;
}

/**
 * Boot the API on an ephemeral port.
 *
 * Port 0 rather than `API_PORT`, so this lane never collides with an API the
 * developer already has running -- and so two of these can exist at once if a
 * future test needs a second instance.
 */
export async function boot(): Promise<Harness> {
  const app: INestApplication = await NestFactory.create(AppModule, { logger: ['error'] });
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');

  const server = app.getHttpServer() as { address(): AddressInfo | string | null };
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the API did not bind a port');

  const db = createPrismaClient({ url: DATABASE_URL });

  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    db,
    close: async () => {
      await db.$disconnect();
      await app.close();
    },
  };
}

/** The three seeded people, with their ids filled in by `loadSeedUsers`. */
export const IRIS: SessionUser = { id: '', email: 'iris@collab.test', name: 'Iris Almeida' };
export const THEO: SessionUser = { id: '', email: 'theo@collab.test', name: 'Theo Nakamura' };
export const MARA: SessionUser = { id: '', email: 'mara@collab.test', name: 'Mara Villalobos' };

/**
 * Read the seeded ids rather than hardcoding them.
 *
 * The seed owns how ids are built, and a copy here would be a second source of
 * truth that stops matching the first time the seed changes -- silently, because
 * a wrong id is just a caller with no access, and every assertion would then be
 * about a 404 that means nothing.
 */
export async function loadSeedUsers(db: PrismaClient): Promise<void> {
  for (const user of [IRIS, THEO, MARA]) {
    const row = await db.user.findUniqueOrThrow({
      where: { email: user.email },
      select: { id: true },
    });
    user.id = row.id;
  }
}

export interface Reply<T = unknown> {
  readonly status: number;
  readonly body: T;
}

/**
 * One request, as a signed-in caller.
 *
 * The token is minted per call rather than cached, for the reason
 * docs/SPECS.md 4.1 gives: a cached one works for two minutes and then fails for
 * the rest of the run, and that failure looks like flakiness.
 *
 * `user: null` sends no `Authorization` header at all, which is how the
 * default-closed guard is exercised.
 */
export async function call<T = unknown>(
  harness: Harness,
  method: string,
  path: string,
  options: { user?: SessionUser | null; body?: unknown; secret?: string } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (options.user !== null && options.user !== undefined) {
    headers.authorization = `Bearer ${mintServiceToken(options.user, options.secret ?? AUTH_SECRET)}`;
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${harness.base}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? undefined : JSON.parse(text)) as T,
  };
}

/**
 * A document owned by `owner`, created through the API so it goes through the
 * same path a person would.
 *
 * Returns the id, and registers nothing: the caller deletes what it made, so a
 * failing test leaves its rows behind to be looked at.
 */
export async function createDocument(
  harness: Harness,
  owner: SessionUser,
  title: string,
): Promise<string> {
  const created = await call<{ id: string }>(harness, 'POST', '/documents', {
    user: owner,
    body: { title },
  });
  if (created.status !== 201) {
    throw new Error(
      `could not create a document: ${String(created.status)} ${JSON.stringify(created.body)}`,
    );
  }
  return created.body.id;
}

/** A title nothing else in the database will share, so a list assertion is about this test. */
export function uniqueTitle(what: string): string {
  return `${what} ${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
}

/** Remove the rows a test created, by id, ignoring what is already gone. */
export async function removeDocuments(db: PrismaClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.document.deleteMany({ where: { id: { in: [...ids] } } });
}
