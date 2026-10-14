/**
 * The durable half of the sync server.
 *
 * Four hooks, and the order between them is the design:
 *
 *   onLoadDocument     apply the checkpoint, replay the log
 *   (Hocuspocus attaches its own update listener here -- hocuspocus-server.esm.js:1487)
 *   afterLoadDocument  attach OUR listener, so the replay is not re-appended
 *   document.on(update) append, synchronously issued, never debounced
 *   onStoreDocument    compact if due, cut a version if due
 *
 * `@hocuspocus/extension-database` is deliberately not used: its `store` hook is
 * the debounced write that docs/SPECS.md section 3.1 exists to avoid, and its
 * `fetch` hook has no room for a log replay.
 */
import type { CompactionPolicy, DocumentRepository } from '@docs/doc-store';
import {
  LOAD_ORIGIN,
  documentFingerprint,
  encodeState,
  loadDocument,
  planCompaction,
  shouldCompact,
} from '@docs/doc-store';
import {
  kindFor,
  nextVersionNumber,
  planPrune,
  shouldCutVersion,
  type LastVersion,
  type VersionPolicy,
} from '@docs/versioning';
import type {
  Extension,
  afterLoadDocumentPayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import { isTransactionOrigin } from '@hocuspocus/server';
import type * as Y from 'yjs';

import { assertDocumentCeiling } from './limits.js';

/** What a freshly written version row is, for a caller that has to answer with it. */
export interface CreatedVersion {
  readonly id: string;
  readonly createdAt: Date;
}

/** The version-history reads and writes this extension needs, kept off the doc-store port. */
export interface VersionStore {
  lastVersion(documentId: string): Promise<(LastVersion & { n: number }) | null>;
  /**
   * Returns the row it wrote.
   *
   * The automatic path throws the answer away -- nothing is waiting on it. The
   * manual one is an HTTP request whose response is the version, and reading it
   * back with a second query would be a second chance to read a different row:
   * two people can cut a version in the same millisecond, and `n` is the only
   * column that separates them.
   */
  createVersion(input: {
    documentId: string;
    n: number;
    state: Uint8Array;
    kind: 'AUTO' | 'MANUAL';
    label: string | null;
    authorId: string | null;
  }): Promise<CreatedVersion>;
  listForPrune(
    documentId: string,
  ): Promise<Array<{ id: string; n: number; kind: 'AUTO' | 'MANUAL' }>>;
  deleteVersions(ids: readonly string[]): Promise<void>;
}

export interface PersistenceOptions {
  readonly repository: DocumentRepository;
  readonly versions: VersionStore;
  readonly compaction: CompactionPolicy;
  readonly versionPolicy: VersionPolicy;
  readonly documentMaxBytes: number;
  /** Injected so the cadence branches are testable without sleeping. */
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/** The listener on one Y.Doc instance, kept so it can be removed when that instance unloads. */
type UpdateListener = (update: Uint8Array, origin: unknown) => void;

export class Persistence implements Extension {
  /**
   * Below `@hocuspocus/extension-redis`, which sets 1000 so its `onStoreDocument`
   * can take the cross-replica lock before anything writes. Ours must run inside
   * that lock, not around it: two replicas compacting one document at the same
   * instant would each truncate what the other had not folded in.
   */
  readonly priority = 100;
  readonly extensionName = 'collab-persistence';

  /**
   * Keyed by the Y.Doc INSTANCE, never by document name.
   *
   * One name can have two live instances for a moment: every client leaves,
   * Hocuspocus begins unloading the document after its store debounce, and a new
   * client connects inside that window, so a fresh Y.Doc is loaded under the same
   * name before the old one's beforeUnloadDocument has run. Keyed by name, the
   * new instance found the old entry and got no listener -- its updates were
   * applied and broadcast and never logged, which is the one failure this module
   * exists to make impossible -- and the old instance's unload then deleted
   * whatever entry the name pointed at. CI found it through the integration
   * lane's file order; `persistence.test.ts` now provokes both halves directly.
   *
   * A WeakMap, so an instance Hocuspocus drops without unloading (a crash path)
   * does not keep its listener reachable from here.
   */
  private readonly loaded = new WeakMap<Y.Doc, UpdateListener>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** Documents whose append failed, so `onStoreDocument` does not compact over a hole. */
  private readonly wounded = new Set<string>();

  constructor(private readonly options: PersistenceOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.info(`[sync] ${message}`));
  }

  /**
   * Hydrate the document: checkpoint, then every logged update above it.
   *
   * Runs BEFORE Hocuspocus attaches its own update listener, so nothing here
   * reaches `onChange` and the hydration cannot be mistaken for an edit.
   *
   * A document that does not exist is left empty rather than created. Creating
   * it here would mean any authenticated client could conjure a row by naming a
   * room -- and the handshake has already established that this caller has a
   * role on a document, so a missing row at this point is a deletion that raced
   * the connection.
   */
  async onLoadDocument(payload: onLoadDocumentPayload): Promise<void> {
    const loadedDocument = await loadDocument(
      this.options.repository,
      payload.documentName,
      payload.document,
    );
    if (loadedDocument === null) {
      this.log(`load ${payload.documentName}: no such document`);
      return;
    }
    this.log(
      `load ${payload.documentName}: checkpoint at seq ${loadedDocument.appliedSeq}, ` +
        `${loadedDocument.replayed} update(s) replayed`,
    );
  }

  /**
   * Start recording.
   *
   * `document.on('update')` is a **Yjs** API, not a Hocuspocus one, so this
   * cannot drift when Hocuspocus changes its hook payloads -- and it catches
   * writes from a `DirectConnection` too, which `onChange` does not distinguish.
   */
  async afterLoadDocument(payload: afterLoadDocumentPayload): Promise<void> {
    const documentId = payload.documentName;
    if (this.loaded.has(payload.document)) return;

    const listener: UpdateListener = (update, origin) => {
      void this.append(documentId, update, origin);
    };
    payload.document.on('update', listener);
    this.loaded.set(payload.document, listener);
  }

  /** Stop recording, so a document that unloads does not leak a listener holding it alive. */
  async beforeUnloadDocument(payload: { documentName: string; document: Y.Doc }): Promise<void> {
    const listener = this.loaded.get(payload.document);
    if (listener === undefined) return;
    payload.document.off('update', listener);
    this.loaded.delete(payload.document);
    // `wounded` stays keyed by name, deliberately left alone here: if a newer
    // instance of this document is already live, a hole recorded against it must
    // keep blocking compaction until one of its own appends succeeds.
  }

  /**
   * Append one update.
   *
   * Two origins are skipped, and both checks are on the transaction origin
   * rather than on ordering, because ordering is not something this file
   * controls:
   *
   *   - `LOAD_ORIGIN`, so a replay is never written back. **The hook ordering
   *     already covers the ordinary path** -- Hocuspocus attaches its update
   *     listener between `onLoadDocument` and `afterLoadDocument`, so the replay
   *     happens before this listener exists, and `hocuspocus-contract.test.ts`
   *     pins that. Removing this line leaves that test green, which is exactly
   *     why the line is here: it is what keeps the ordinary path from being the
   *     ONLY protection. It covers a re-hydration after load, a future version
   *     that moves the hooks, and any caller that applies the log into a
   *     document already being recorded. `persistence.test.ts` provokes that
   *     case directly.
   *   - `{ source: 'redis' }`, the origin `@hocuspocus/extension-redis` relays
   *     with. The replica that received the update from a client already
   *     appended it. Appending again would be CORRECT -- Yjs updates are
   *     idempotent, so replay still produces the right document -- and would
   *     double the log for nothing. It is an optimisation, and the comment says
   *     so because otherwise the next reader deletes it while fixing a real bug
   *     and cannot tell whether they broke something.
   */
  private async append(documentId: string, update: Uint8Array, origin: unknown): Promise<void> {
    if (origin === LOAD_ORIGIN) return;
    if (isTransactionOrigin(origin) && origin.source === 'redis') return;

    const authorId = authorOf(origin);
    try {
      const seq = await this.options.repository.appendUpdate(documentId, update, authorId);
      this.wounded.delete(documentId);
      if (seq % 100n === 0n) this.log(`append ${documentId}: seq ${seq}`);
    } catch (error) {
      // The document in memory is ahead of the log now. Compaction is blocked
      // until an append succeeds, because a checkpoint taken here would claim to
      // contain an update that was never durably written, and the truncation
      // that follows would delete rows around the hole.
      this.wounded.add(documentId);
      this.log(`append ${documentId} FAILED: ${(error as Error).message}`);
    }
  }

  /**
   * Compact if due, then cut a version if due.
   *
   * Hocuspocus debounces this hook by `STORE_DEBOUNCE_MS`, which is fine and is
   * why it is the right place for compaction: compaction is a performance
   * concern, not a durability one. The log is what survives a crash.
   */
  async onStoreDocument(payload: onStoreDocumentPayload): Promise<void> {
    const documentId = payload.documentName;
    if (this.wounded.has(documentId)) {
      this.log(`store ${documentId}: skipped, an append failed and the log has a hole`);
      return;
    }

    await this.maybeCompact(documentId, payload.document);
    await this.maybeCutVersion(documentId, payload.document);
  }

  private async maybeCompact(documentId: string, document: Y.Doc): Promise<void> {
    const pending = await this.options.repository.pendingUpdates(documentId);
    if (!shouldCompact(pending, this.options.compaction, this.now())) return;

    // Read the rows BEFORE encoding the state, and fold in only what was read.
    // The other replica may append between these two calls; a checkpoint that
    // claimed those rows would let the truncation delete an update it does not
    // contain, which is the one unrecoverable failure in the design.
    const folded = await this.options.repository.loadUpdates(documentId, 0n);
    const plan = planCompaction(documentId, document, folded);
    if (plan === null) return;

    assertDocumentCeiling(plan.state.byteLength, 0, this.options.documentMaxBytes);
    await this.options.repository.compact(plan);
    this.log(`compact ${documentId}: folded ${folded.length} update(s) up to seq ${plan.stateSeq}`);
  }

  private async maybeCutVersion(documentId: string, document: Y.Doc): Promise<void> {
    const last = await this.options.versions.lastVersion(documentId);
    const fingerprint = documentFingerprint(document);
    if (!shouldCutVersion(last, fingerprint, this.options.versionPolicy, new Date(this.now())))
      return;

    const n = nextVersionNumber(last?.n ?? null);
    await this.options.versions.createVersion({
      documentId,
      n,
      state: encodeState(document),
      kind: kindFor(null),
      label: null,
      // An automatic version has no author. It records the document, not a
      // decision somebody made, and attributing it to whoever happened to type
      // last would be a name against a cut they did not ask for.
      authorId: null,
    });

    const existing = await this.options.versions.listForPrune(documentId);
    const doomed = planPrune(existing, this.options.versionPolicy);
    if (doomed.length > 0) await this.options.versions.deleteVersions(doomed);
    this.log(
      `version ${documentId}: cut ${n}${doomed.length > 0 ? `, pruned ${doomed.length}` : ''}`,
    );
  }
}

/**
 * The author of an update, when there is one.
 *
 * `context` is what `onAuthenticate` returned, so this is the same user the
 * handshake authorised -- never anything the client sent with the update. A
 * relayed or local origin has no author, and `author_id` is nullable for exactly
 * that reason.
 */
function authorOf(origin: unknown): string | null {
  if (!isTransactionOrigin(origin) || origin.source !== 'connection') return null;
  const context = origin.connection.context as { user?: { id?: unknown } } | undefined;
  const id = context?.user?.id;
  return typeof id === 'string' ? id : null;
}
