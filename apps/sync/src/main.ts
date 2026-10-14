/**
 * The sync server: one process, one `http.Server`, both the websocket upgrade
 * and `/health` on it.
 *
 * One server rather than two ports, because a health check on a different
 * listener answers for a different thing. The Docker healthcheck has to hit the
 * process the sockets are on, or a replica whose websocket handling is wedged
 * reports healthy from a listener that has nothing to do.
 */
import { documentFingerprint, docFromState, loadDocument } from '@docs/doc-store';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';

import {
  authoriseDocumentRequest,
  authoriseHandshake,
  documentIdFromRoom,
  shareTokenFrom,
  HandshakeRefused,
  type AccessLookup,
} from './auth.js';
import { connectDependencies, type Dependencies } from './boot.js';
import { loadConfig, type SyncConfig } from './config.js';
import { checkHealth, statusCodeFor } from './health.js';
import { mountRoutes } from './http.js';
import { ConnectionLimiter, assertPayloadSize } from './limits.js';
import { Persistence } from './persistence.js';
import { PrismaVersionStore, computeDiff, cutManualVersion } from './versions.js';

const startedAt = Date.now();

function fingerprintOfState(state: Uint8Array): string {
  const doc = docFromState(state);
  try {
    return documentFingerprint(doc);
  } finally {
    doc.destroy();
  }
}

export async function start(config: SyncConfig, dependencies: Dependencies): Promise<Server> {
  const { prisma, repository, redis, probeSubscriber } = dependencies;
  const versionStore = new PrismaVersionStore(prisma, fingerprintOfState);

  // One limiter per connection, dropped when the socket closes. Keyed by
  // socketId rather than by user: the limit is on a socket, and a person with
  // three tabs open is three sockets doing three tabs' worth of typing.
  const limiters = new Map<string, ConnectionLimiter>();

  /**
   * The three queries the authorisation decision needs, in one object.
   *
   * Shared by the socket handshake and by both HTTP routes, deliberately: a
   * second copy of "how do I find this caller's role" is a second thing that can
   * drift, and the looser of two is the one that decides.
   */
  const lookup: AccessLookup = {
    membership: async (id, userId) => {
      const row = await prisma.documentMember.findUnique({
        where: { documentId_userId: { documentId: id, userId } },
        select: { role: true },
      });
      return row?.role ?? null;
    },
    shareLink: async (token) =>
      prisma.shareLink.findUnique({
        where: { token },
        select: { documentId: true, role: true, expiresAt: true, revokedAt: true },
      }),
    documentExists: async (id) =>
      (await prisma.document.count({ where: { id, deletedAt: null } })) > 0,
  };

  const server = new Server({
    port: config.port,
    quiet: true,
    debounce: config.storeDebounceMs,
    maxDebounce: config.storeMaxDebounceMs,
    extensions: [
      new RedisExtension({
        // Duplicated from the connection we already opened and proved, rather
        // than dialled again from the URL: one place where a bad REDIS_URL
        // fails, and it is boot.
        redis: redis.duplicate(),
        prefix: 'collab',
        identifier: `sync-${config.port}`,
      }),
      new Persistence({
        repository,
        versions: versionStore,
        compaction: config.compaction,
        versionPolicy: config.versions,
        documentMaxBytes: config.documentMaxBytes,
      }),
      {
        extensionName: 'collab-auth',
        async onAuthenticate(payload) {
          const documentId = documentIdFromRoom(payload.documentName);
          try {
            const result = await authoriseHandshake(
              {
                token: payload.token,
                documentId,
                shareToken: shareTokenFrom(payload.requestParameters),
                now: new Date(),
              },
              config.authSecret,
              lookup,
            );

            // The one line the read-only guarantee rests on. Hocuspocus drops
            // writes from a read-only connection itself (SPECS 4.2); the
            // decision is ours and this is it.
            payload.connectionConfig.readOnly = result.readOnly;
            return result.context;
          } catch (error) {
            // The reason class goes to the log. The client gets one message for
            // every refusal, because "expired signature" tells somebody probing
            // that the token was real and the secret is right.
            const reason = error instanceof HandshakeRefused ? error.reason : 'error';
            console.warn(`[sync] handshake refused for ${documentId}: ${reason}`);
            throw error;
          }
        },

        async beforeHandleMessage(payload) {
          assertPayloadSize(payload.update.byteLength, {
            messagesPerMinute: config.messageRateLimit,
            maxPayloadBytes: config.maxPayloadBytes,
          });

          let limiter = limiters.get(payload.socketId);
          if (limiter === undefined) {
            limiter = new ConnectionLimiter({
              messagesPerMinute: config.messageRateLimit,
              maxPayloadBytes: config.maxPayloadBytes,
            });
            limiters.set(payload.socketId, limiter);
          }
          if (!limiter.admit(Date.now())) {
            throw new Error('Too many messages; slow down');
          }
          // Deliberately NOT re-checking `connection.readOnly` here.
          // `MessageReceiver.applySyncMessage` already does, and a second copy
          // of an enforcement rule is a second thing that can drift out of
          // agreement with the first. See docs/SPECS.md section 4.2.
        },

        async onDisconnect(payload) {
          limiters.delete(payload.socketId);
        },
      },
    ],
  });

  mountRoutes(server.httpServer, server.requestHandler, {
    async health() {
      const body = await checkHealth({
        version: config.appVersion,
        startedAt,
        query: () => prisma.$queryRaw`SELECT 1`,
        redis,
        probeSubscriber,
        counts: () => ({
          connections: server.hocuspocus.getConnectionsCount(),
          documents: server.hocuspocus.getDocumentsCount(),
        }),
      });
      return { body, status: statusCodeFor(body) };
    },

    async diff(credentials, documentId, from, to) {
      // Authorised before a single row is read, and by the same function the
      // socket handshake uses. A diff is the document's text; an endpoint that
      // served one without a credential would publish every document to anybody
      // who could guess an id.
      await authoriseDocumentRequest(
        {
          token: credentials.token,
          documentId,
          shareToken: credentials.shareToken,
          now: new Date(),
        },
        config.authSecret,
        lookup,
        'version.read',
      );

      return computeDiff(
        { documentId, from, to },
        {
          versionState: async (id, n) => {
            const row = await prisma.documentVersion.findUnique({
              where: { documentId_n: { documentId: id, n } },
              select: { state: true },
            });
            return row === null ? null : Uint8Array.from(row.state);
          },
          liveState: async (id) => {
            // Through the same load path the sync server uses, so the diff is
            // against what a reader would see rather than against the last
            // checkpoint, which on a busy document is paragraphs behind.
            const doc = new Y.Doc();
            try {
              const loaded = await loadDocument(repository, id, doc);
              return loaded === null ? null : Y.encodeStateAsUpdate(doc);
            } finally {
              doc.destroy();
            }
          },
        },
      );
    },

    async createVersion(credentials, documentId, label) {
      const context = await authoriseDocumentRequest(
        {
          token: credentials.token,
          documentId,
          shareToken: credentials.shareToken,
          now: new Date(),
        },
        config.authSecret,
        lookup,
        'version.create',
      );

      return cutManualVersion(
        {
          documentId,
          label,
          // From the verified token, never from the body. An author id a client
          // could choose is an author id a client would choose.
          authorId: context.user.id,
          authorName: context.user.name,
        },
        { versions: versionStore, repository, policy: config.versions },
      );
    },
  });

  await server.listen();
  console.info(`[sync] listening on ${config.port} (documents via ws, /health via http)`);
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dependencies = await connectDependencies(config);

  let server: Server;
  try {
    server = await start(config, dependencies);
  } catch (error) {
    // Everything opened, closed, before the process leaves. A container that
    // crash-loops with a live Postgres pool holds a connection slot per
    // iteration.
    await dependencies.close();
    throw error;
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[sync] ${signal}: draining`);
    // Flush first: pending debounced `onStoreDocument` calls are the compactions
    // and the version cuts. Closing without them loses no DATA -- the log has it
    // -- but leaves every document to replay its whole log on next load.
    server.hocuspocus.flushPendingStores();
    await server.destroy();
    await dependencies.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// `import.meta.url` against argv[1]: this module is imported by tests, and a
// top-level `main()` would start a server on every test run.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === `file://${entryPoint}`) {
  main().catch((error: unknown) => {
    console.error('[sync] failed to start:', error);
    process.exit(1);
  });
}
