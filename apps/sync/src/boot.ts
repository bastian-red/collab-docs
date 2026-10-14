/**
 * Bringing dependencies up, and taking them all down again if any one of them
 * fails.
 *
 * The shape here exists because the naive version leaks. Open Postgres, then
 * open Redis, and if Redis throws, the process exits with a live Postgres pool
 * and an unhandled rejection -- which in a container is a crash loop that holds
 * a connection slot on every iteration.
 *
 * The other half is error listeners. `ioredis` emits `error` on an unreachable
 * server, and an `EventEmitter` with no `error` listener THROWS the error
 * instead of emitting it. So the listener goes on before anything can connect,
 * not after.
 */
import { createPrismaClient, type PrismaClient } from '@docs/db';
import { PrismaDocumentRepository } from '@docs/db/documents';
import { HEALTH_PROBE_CHANNEL } from '@docs/shared';
import { Redis } from 'ioredis';

import type { SyncConfig } from './config.js';

export interface Dependencies {
  readonly prisma: PrismaClient;
  readonly repository: PrismaDocumentRepository;
  /** Publishes the health nonce, and is the connection the Redis extension duplicates from. */
  readonly redis: Redis;
  /** Subscribes for the duration of a health probe, and nothing else. */
  readonly probeSubscriber: Redis;
  close(): Promise<void>;
}

/**
 * `lazyConnect` plus an explicit `connect()`, rather than letting ioredis dial
 * in the constructor.
 *
 * Constructing eagerly means the connection attempt races the `on('error')`
 * registration two lines below it. That race is invisible on a healthy machine
 * and is exactly the case this code has to survive: Redis being down at boot.
 */
function redisClient(url: string, role: string, onError: (error: Error) => void): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    // The default retries forever with backoff, which means a sync server with a
    // typo in REDIS_URL "starts" and then silently never relays anything. Three
    // attempts, then boot fails loudly.
    maxRetriesPerRequest: 3,
    connectionName: `collab-sync-${role}`,
  });
  client.on('error', onError);
  return client;
}

export async function connectDependencies(config: SyncConfig): Promise<Dependencies> {
  // Named so the teardown below can close whatever got as far as existing,
  // regardless of which step threw.
  let prisma: PrismaClient | null = null;
  let redis: Redis | null = null;
  let probeSubscriber: Redis | null = null;

  const closeAll = async (): Promise<void> => {
    // `allSettled`, not `all`: one close failing must not prevent the others,
    // and there is nothing useful to do with a failure at this point beyond not
    // making it worse.
    await Promise.allSettled([prisma?.$disconnect(), redis?.quit(), probeSubscriber?.quit()]);
  };

  try {
    prisma = createPrismaClient({ url: config.databaseUrl });
    // An explicit connect, so a bad DATABASE_URL fails here rather than on the
    // first document load, by which point a client is already waiting on a
    // socket that will never sync.
    await prisma.$connect();

    // After boot, an error on either connection is logged and not thrown: the
    // process is serving live sockets, and ioredis reconnects on its own. During
    // boot the same listener rejects, via the `connect()` call below.
    const logError = (role: string) => (error: Error) => {
      console.error(`[sync] redis(${role}): ${error.message}`);
    };

    redis = redisClient(config.redisUrl, 'pub', logError('pub'));
    probeSubscriber = redisClient(config.redisUrl, 'probe', logError('probe'));
    await Promise.all([redis.connect(), probeSubscriber.connect()]);

    // Proof the subscriber half works at all, before any traffic depends on it.
    // Subscribing to the probe channel here also means `health.ts` never has to
    // subscribe on the hot path; it only listens.
    await probeSubscriber.subscribe(HEALTH_PROBE_CHANNEL);

    const repository = new PrismaDocumentRepository(prisma);
    const dependencies: Dependencies = {
      prisma,
      repository,
      redis,
      probeSubscriber,
      close: closeAll,
    };
    return dependencies;
  } catch (error) {
    await closeAll();
    throw error;
  }
}
