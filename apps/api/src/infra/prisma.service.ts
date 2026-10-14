/**
 * The Prisma client, as a Nest provider with a real lifecycle.
 *
 * `onModuleInit` connects **eagerly**. Prisma's default is to connect on the
 * first query, which turns "the database is unreachable" into an error on
 * whichever request happened to arrive first: a user-facing 500 for an
 * operational fact that was true before the process started. Connecting at boot
 * means the process fails to start instead, with the host in the message.
 *
 * `onModuleDestroy` disconnects, so a `SIGTERM` during a restart returns the pool
 * rather than leaving Postgres to time the connections out.
 *
 * **What this client is never used for.** It writes `documents.state` and
 * `document_updates` in exactly no place, because those belong to `apps/sync`
 * (docs/SPECS.md 2.2). That is not a convention here: `@docs/db/documents`
 * publishes no `require` condition, so the repository that owns those writes
 * cannot even be resolved from this CommonJS package.
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@docs/db';

import { API_CONFIG, type ApiConfig } from '../config/config';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  // A plain constructor parameter, not `import type`. `emitDecoratorMetadata`
  // writes the constructor's parameter types at compile time and Nest resolves
  // dependencies from them; an `import type` erases the class, the metadata
  // records `undefined`, and injection fails at runtime with an error pointing
  // nowhere near the import. See docs/CODESTYLE.md.
  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    // Composition rather than `extends PrismaClient`. The generated client is
    // emitted into `packages/db/generated/` and is not a stable base class to
    // inherit from across a `pnpm deploy --prod` layer that rebuilds
    // node_modules; `createPrismaClient` is the one place that knows where it
    // lives.
    this.client = createPrismaClient({ url: config.databaseUrl });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
