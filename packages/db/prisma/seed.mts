/**
 * The demo workspace.
 *
 * Five properties, each with the mechanism that holds it.
 *
 * **1. The documents are built by the real write path.** Every paragraph goes
 * through `PrismaDocumentRepository.appendUpdate`, which allocates its `seq`
 * with `UPDATE documents SET next_seq = next_seq + 1 RETURNING`, and the
 * checkpoint is written by `planCompaction` + `repository.compact`. Hand-writing
 * a `state` blob would seed a document the allocator never produced, and the one
 * thing this project exists to demonstrate is that the checkpoint-plus-log
 * design is what produces them. A seed that bypassed it could stay green while
 * the append path was broken.
 *
 * **2. The demo document is deliberately left mid-log.** It carries a checkpoint
 * AND four un-compacted updates above it, so a fresh clone exercises the replay
 * on its first page load rather than reading a checkpoint that happens to be the
 * whole document. `scripts/dev-smoke.sh` reads the text that only replay
 * produces.
 *
 * **3. It is deterministic.** Fixed ids, a fixed reference date, no
 * `Math.random()`, and every `Y.Doc` gets an explicit `clientID`. That last one
 * is not decoration: a Y.Doc assigns itself a RANDOM client id, and the id is
 * written into every item the document contains. Measured -- one paragraph,
 * encoded twice, unpinned:
 *
 *     0103e3d4d5a7010007010764656661756c74...
 *     0103b2ffc2c80a0007010764656661756c74...
 *
 * Pinned, the two are identical. The client id is also what breaks ties between
 * concurrent inserts, so an unpinned seed that ever wrote from two docs at once
 * would produce a different DOCUMENT, not merely different bytes. Timestamps are
 * rewritten to fixed values at the end, because `created_at` defaults to
 * `now()`.
 *
 * **4. It is idempotent, by an explicit ordered teardown of exactly the seeded
 * rows.** Documents go first (cascading to updates, versions, members and
 * links), then folders, then users. The naive order fails on the second run:
 * `documents.folder_id` and `share_links.created_by_id` are both `SET NULL`, so
 * deleting the users leaves every document standing and the next run adds a
 * second copy. Only rows with the `seed-` id prefix are touched, so running this
 * against a database somebody was using does not empty it.
 *
 * **5. The constants are readable from outside.** `scripts/seed-check.sh` and
 * `scripts/dev-smoke.sh` `sed` these out of this file rather than repeating
 * them. A copy that drifts produces a check confidently computed over zero rows,
 * which passes.
 */
import { DOCUMENT_FRAGMENT, encodeState, loadDocument, planCompaction, plainTextOf } from '@docs/doc-store';
import { idSchema } from '@docs/shared';
import { hashPassword } from '@docs/shared/server';
import * as Y from 'yjs';

import { PrismaDocumentRepository } from '../src/document-repository.mjs';
import pkg from '../generated/client/index.js';

const { PrismaClient } = pkg;

// --- The constants the scripts read. One line each, single quotes, no template
// literals: `sed -n "s/^const NAME = '\([^']*\)';.*/\1/p"` is what reads them.
const DEMO_EMAIL = 'iris@collab.test';
const DEMO_PASSWORD = 'demo-password-2026';
const DEMO_DOCUMENT = 'Sync protocol notes';
const DEMO_PARAGRAPH = 'Nothing on the durability path is debounced.';
const EDITOR_EMAIL = 'theo@collab.test';
const VIEWER_EMAIL = 'mara@collab.test';

/**
 * A fixed share token, so the E2E suite can open the view-only link without
 * first reading it out of the database.
 *
 * Fixed and therefore not a secret, which is why it is an obvious placeholder
 * rather than the output of `mintShareToken()`. A real 32-byte token generated
 * here would look like a live credential to every secret scanner, and
 * `mintShareToken` stays the only way a real link is ever made.
 */
const SEED_SHARE_TOKEN = 'seed-share-token-view-only-not-a-secret';

/**
 * The instant everything is anchored to. Fixed, and in UTC, so a machine in
 * Santiago and a runner in UTC seed the same workspace -- the document list is
 * ordered by `updated_at` and the E2E suite asserts on that order.
 */
const REFERENCE = new Date('2026-08-10T09:00:00.000Z');

function at(minutesAfter: number): Date {
  return new Date(REFERENCE.getTime() + minutesAfter * 60_000);
}

/**
 * A fixed id that is still a valid one.
 *
 * `idSchema` in `@docs/shared` is 20-40 lowercase alphanumerics -- the shape
 * `cuid()` produces -- and every contract in the application parses ids through
 * it. A readable `seed-doc-sync` would therefore be rejected by the sync
 * server's handshake and by every API response schema, so the seeded workspace
 * would be unreachable through the real code paths while looking perfectly fine
 * in psql. Fixed AND well-shaped: padded with zeros to a constant width, so it
 * stays greppable, stays deterministic, and parses.
 *
 * `assertSeedIds()` checks every one of them against the real schema before the
 * seed writes anything, so this cannot quietly stop being true.
 */
function seedId(kind: string, name: string): string {
  return `c${kind}${name}${'0'.repeat(40)}`.slice(0, 25);
}

const prisma = new PrismaClient();
const repository = new PrismaDocumentRepository(prisma);

const USERS = [
  { id: seedId('user', 'iris'), email: DEMO_EMAIL, name: 'Iris Almeida' },
  { id: seedId('user', 'theo'), email: EDITOR_EMAIL, name: 'Theo Nakamura' },
  { id: seedId('user', 'mara'), email: VIEWER_EMAIL, name: 'Mara Villalobos' },
] as const;

const FOLDERS = [
  { id: seedId('folder', 'engineering'), name: 'Engineering', parentId: null },
  { id: seedId('folder', 'drafts'), name: 'Drafts', parentId: seedId('folder', 'engineering') },
] as const;

interface SeedDocument {
  readonly id: string;
  readonly title: string;
  readonly folderId: string | null;
  /** Pinned, never random. See property 3 above. */
  readonly clientId: number;
  readonly paragraphs: readonly string[];
  /**
   * How many paragraphs are folded into the checkpoint. The rest stay in the log
   * so the load path has something to replay.
   */
  readonly compactAfter: number;
  readonly deleted?: boolean;
}

const DOCUMENTS: readonly SeedDocument[] = [
  {
    id: seedId('doc', 'sync'),
    title: DEMO_DOCUMENT,
    folderId: seedId('folder', 'engineering'),
    clientId: 101,
    paragraphs: [
      'A CRDT lives in memory. Persistence is the part that is actually hard.',
      'The naive design debounces the write, so a crash loses every keystroke since the last one.',
      DEMO_PARAGRAPH,
      'Every update is appended synchronously to document_updates, with a seq allocated by Postgres.',
      'Compaction folds the log into documents.state inside one transaction, and truncates only what it folded in.',
      'If the process dies between the two, load replays updates already in the checkpoint. Yjs updates are idempotent, so the result is identical.',
      'Read-only is enforced at the sync layer. A role enforced in the editor is a lie.',
    ],
    compactAfter: 3,
  },
  {
    id: seedId('doc', 'retro'),
    title: 'Weekly retro',
    folderId: seedId('folder', 'engineering'),
    clientId: 102,
    paragraphs: [
      'What went well: the convergence property test found the equality bug before the integration lane did.',
      'What did not: the tsvector column had to come out. Prisma reads a generated column as a default.',
      'Next: two sync replicas behind the Redis extension.',
    ],
    compactAfter: 2,
  },
  {
    id: seedId('doc', 'onboarding'),
    title: 'Onboarding checklist',
    folderId: null,
    clientId: 103,
    paragraphs: [
      'Start the datastores: docker compose -f infra/docker-compose.yml up -d.',
      'Apply the migrations, seed, then run pnpm dev.',
      'Open two browser windows on the same document and type in both.',
    ],
    compactAfter: 3,
  },
  {
    id: seedId('doc', 'archived'),
    title: 'Superseded draft',
    folderId: seedId('folder', 'drafts'),
    clientId: 104,
    paragraphs: ['Replaced by the sync protocol notes.'],
    compactAfter: 1,
    // Soft-deleted, so the load path's `deleted_at IS NULL` filter and the
    // document list's exclusion both have something to be right about.
    deleted: true,
  },
];

/**
 * Delete the seeded rows, in an order the foreign keys allow.
 *
 * Documents cascade to updates, versions, members and links. Folders cascade to
 * their children. Users go last, because two of the columns pointing at them are
 * `SET NULL` rather than `CASCADE`, so deleting a user does NOT remove the rows
 * that reference them -- it silently orphans them, and the next run adds a
 * second copy of everything beside the orphans.
 */
async function teardown(): Promise<void> {
  await prisma.document.deleteMany({ where: { id: { in: DOCUMENTS.map((document) => document.id) } } });
  await prisma.folder.deleteMany({ where: { id: { in: FOLDERS.map((folder) => folder.id) } } });
  // Users go by EMAIL, not by id. Email is the unique constraint, so it is the
  // one that collides -- and it is stable across a change to how ids are
  // generated, which an id-keyed delete is not. That is not hypothetical: the
  // seed ids were readable strings until `idSchema` turned out to require a cuid
  // shape, and an id-keyed teardown left the previous three users standing and
  // failed the next run on `users_email_key`.
  await prisma.user.deleteMany({ where: { email: { in: USERS.map((user) => user.email) } } });
}

/**
 * Append one paragraph as its own Yjs update, through the real allocator.
 *
 * One transaction per paragraph rather than one for all of them, so the log has
 * several rows and the replay has something to do. The update is captured from
 * `doc.on('update')` -- the Yjs API, not a Hocuspocus one -- which is the same
 * listener `apps/sync` attaches.
 */
async function appendParagraph(doc: Y.Doc, documentId: string, text: string, authorId: string): Promise<void> {
  let captured: Uint8Array | null = null;
  const capture = (update: Uint8Array): void => {
    captured = update;
  };
  doc.on('update', capture);
  try {
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
    const paragraph = new Y.XmlElement('paragraph');
    Y.transact(doc, () => {
      fragment.insert(fragment.length, [paragraph]);
      paragraph.insert(0, [new Y.XmlText(text)]);
    });
  } finally {
    doc.off('update', capture);
  }

  if (captured === null) throw new Error(`No Yjs update was produced for "${text}".`);
  await repository.appendUpdate(documentId, captured, authorId);
}

/**
 * Compact through the same plan the sync server uses.
 *
 * A fresh Y.Doc is loaded from the repository rather than reusing the one that
 * wrote the updates, because that is what the sync server does on every load,
 * and doing it here means the seed proves the load path too.
 */
async function compactUpTo(documentId: string, foldRows: number): Promise<void> {
  const rows = await repository.loadUpdates(documentId, 0n);
  const folded = rows.slice(0, foldRows);

  // A document holding ONLY the folded updates. The checkpoint has to be the
  // state as of `state_seq`, not the state as of now: one that contained updates
  // still sitting in the log would let the truncation delete rows it had never
  // folded in, which is the one unrecoverable failure in the whole design
  // (docs/SPECS.md section 3.2).
  const checkpoint = new Y.Doc();
  checkpoint.clientID = 2;
  try {
    Y.transact(checkpoint, () => {
      for (const row of folded) Y.applyUpdate(checkpoint, row.update);
    });
    const plan = planCompaction(documentId, checkpoint, folded);
    if (plan !== null) await repository.compact(plan);
  } finally {
    checkpoint.destroy();
  }
}

/**
 * Load every seeded document the way the sync server does, and check the prose.
 *
 * The seed's own regression test, and the reason it is worth having: this is the
 * only place that reads back what it wrote, through the real
 * checkpoint-plus-replay path. A compaction that folded in too much, a
 * checkpoint written from the wrong document, or a truncation that removed a row
 * above `state_seq` all show up here as a missing paragraph rather than as a
 * green seed and a broken app.
 */
async function verifyLoads(): Promise<void> {
  for (const document of DOCUMENTS) {
    const doc = new Y.Doc();
    doc.clientID = 1;
    try {
      const loaded = await loadDocument(repository, document.id, doc);
      if (document.deleted === true) {
        if (loaded !== null) throw new Error(`Soft-deleted ${document.id} still loads.`);
        continue;
      }
      if (loaded === null) throw new Error(`Document ${document.id} did not load.`);
      const text = plainTextOf(doc);
      for (const paragraph of document.paragraphs) {
        if (!text.includes(paragraph)) {
          throw new Error(`Document ${document.id} lost a paragraph in the round trip: "${paragraph}"`);
        }
      }
    } finally {
      doc.destroy();
    }
  }
}

/** A version row is a full state, never a diff. See docs/SPECS.md section 5.1. */
async function cutVersion(
  documentId: string,
  n: number,
  through: number,
  kind: 'AUTO' | 'MANUAL',
  label: string | null,
  authorId: string,
  createdAt: Date,
): Promise<void> {
  const rows = await repository.loadUpdates(documentId, 0n);
  const snapshot = await repository.loadSnapshot(documentId);
  if (snapshot === null) throw new Error(`Document ${documentId} vanished mid-seed.`);

  const doc = new Y.Doc();
  doc.clientID = 3;
  try {
    Y.transact(doc, () => {
      Y.applyUpdate(doc, snapshot.state);
      // By seq, not by array position: compaction has already deleted the rows
      // at or below `state_seq`, so the array's indices no longer line up with
      // the paragraph numbers.
      for (const row of rows.filter((candidate) => candidate.seq <= BigInt(through))) {
        Y.applyUpdate(doc, row.update);
      }
    });
    await prisma.documentVersion.create({
      data: {
        id: seedId('version', `${n}${documentId.slice(1, 12)}`),
        documentId,
        n,
        state: Buffer.from(encodeState(doc)),
        kind,
        label,
        authorId,
        createdAt,
      },
    });
  } finally {
    doc.destroy();
  }
}

/**
 * Pin every timestamp.
 *
 * Raw SQL rather than Prisma updates: `updated_at` carries `@updatedAt`, and the
 * point here is to write a value that is NOT now.
 */
async function pinTimestamps(): Promise<void> {
  const ids = DOCUMENTS.map((document) => document.id);
  // `= ANY(ids)` rather than a `LIKE 'seed-%'` prefix: the ids are cuid-shaped
  // now (see `seedId`), so there is no prefix to match on, and matching a
  // prefix would in any case rewrite timestamps on rows this seed did not
  // create.
  const userIds = USERS.map((user) => user.id);
  const folderIds = FOLDERS.map((folder) => folder.id);
  await prisma.$executeRaw`
    UPDATE "users" SET "created_at" = ${REFERENCE}, "updated_at" = ${REFERENCE}
     WHERE "id" = ANY(${userIds})
  `;
  await prisma.$executeRaw`
    UPDATE "folders" SET "created_at" = ${REFERENCE} WHERE "id" = ANY(${folderIds})
  `;
  for (const [index, document] of DOCUMENTS.entries()) {
    // Descending recency, so the document list has a stable, meaningful order
    // rather than one decided by how fast the seed ran.
    const updatedAt = at(600 - index * 45);
    await prisma.$executeRaw`
      UPDATE "documents"
         SET "created_at" = ${REFERENCE}, "updated_at" = ${updatedAt}
       WHERE "id" = ${document.id}
    `;
  }
  await prisma.$executeRaw`
    UPDATE "document_updates" SET "created_at" = ${at(30)}
     WHERE "document_id" = ANY(${ids})
  `;
  await prisma.$executeRaw`
    UPDATE "document_members" SET "added_at" = ${at(5)} WHERE "document_id" = ANY(${ids})
  `;
  await prisma.$executeRaw`
    UPDATE "share_links" SET "created_at" = ${at(10)} WHERE "document_id" = ANY(${ids})
  `;
}

/**
 * Every id this seed will write, parsed by the real schema before anything is
 * written.
 *
 * The failure this closes: ids that are fine in psql and rejected by every
 * contract in the application, so the seeded workspace looks correct in the
 * database and 400s in the browser.
 */
function assertSeedIds(): void {
  const ids = [
    ...USERS.map((user) => user.id),
    ...FOLDERS.map((folder) => folder.id),
    ...DOCUMENTS.map((document) => document.id),
  ];
  for (const id of ids) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) {
      throw new Error(`Seed id ${JSON.stringify(id)} is not a valid id: ${parsed.error.message}`);
    }
  }
  if (new Set(ids).size !== ids.length) {
    // `seedId` truncates to 25 characters, so two long names could collide and
    // the second create would fail somewhere far from here.
    throw new Error('Two seed ids collided after truncation.');
  }
}

async function main(): Promise<void> {
  assertSeedIds();
  await teardown();

  // One hash, computed once and reused. scrypt is memory-hard on purpose, and
  // three of them is three times the cost for no extra coverage.
  const passwordHash = hashPassword(DEMO_PASSWORD);
  await prisma.user.createMany({
    data: USERS.map((user) => ({ id: user.id, email: user.email, name: user.name, passwordHash })),
  });

  for (const folder of FOLDERS) {
    await prisma.folder.create({
      data: { id: folder.id, name: folder.name, ownerId: seedId('user', 'iris'), parentId: folder.parentId },
    });
  }

  for (const document of DOCUMENTS) {
    await prisma.document.create({
      data: {
        id: document.id,
        title: document.title,
        folderId: document.folderId,
        // The encoded state of an empty Y.Doc, so no read path has to branch on
        // "has this ever been saved". Two bytes, and never zero:
        // CHECK (octet_length(state) > 0).
        state: Buffer.from(encodeState(new Y.Doc())),
        members: {
          create: [
            { userId: seedId('user', 'iris'), role: 'OWNER' },
            { userId: seedId('user', 'theo'), role: 'EDITOR' },
            { userId: seedId('user', 'mara'), role: 'VIEWER' },
          ],
        },
      },
    });

    const doc = new Y.Doc();
    doc.clientID = document.clientId;
    try {
      for (const [index, paragraph] of document.paragraphs.entries()) {
        // Alternating authorship, so the update log shows more than one person
        // and `author_id IS NULL` is not the only thing a reader ever sees.
        const authorId = index % 2 === 0 ? seedId('user', 'iris') : seedId('user', 'theo');
        await appendParagraph(doc, document.id, paragraph, authorId);
      }
    } finally {
      doc.destroy();
    }

    await compactUpTo(document.id, document.compactAfter);

    // Soft-deleted LAST, never at creation. `appendUpdate` refuses a document
    // with `deleted_at` set -- correctly, because a deleted document must not be
    // writable by a client that kept the URL -- so a row created already deleted
    // could never be given any content. A soft-deleted document with no text in
    // it would also make the "deleted documents are excluded from the list"
    // assertion pass for the wrong reason.
    if (document.deleted === true) {
      await prisma.document.update({ where: { id: document.id }, data: { deletedAt: at(700) } });
    }
  }

  // Three versions on the demo document: two automatic and one a person named.
  // The labelled one is what `services/versioning`'s pruning refuses to delete.
  await cutVersion(seedId('doc', 'sync'), 1, 3, 'AUTO', null, seedId('user', 'iris'), at(60));
  await cutVersion(seedId('doc', 'sync'), 2, 5, 'MANUAL', 'Before the read-only section', seedId('user', 'iris'), at(120));
  await cutVersion(seedId('doc', 'sync'), 3, 7, 'AUTO', null, seedId('user', 'theo'), at(180));

  await prisma.shareLink.createMany({
    data: [
      {
        id: seedId('link', 'live'),
        documentId: seedId('doc', 'sync'),
        token: SEED_SHARE_TOKEN,
        role: 'VIEWER',
        expiresAt: null,
        createdById: seedId('user', 'iris'),
        createdAt: at(10),
      },
      {
        // A revoked link, so the refusal path has a row to be refused on and the
        // sharing panel has something to render in its revoked state.
        id: seedId('link', 'revoked'),
        documentId: seedId('doc', 'sync'),
        token: `${SEED_SHARE_TOKEN}-revoked`,
        role: 'EDITOR',
        expiresAt: null,
        revokedAt: at(300),
        // Explicit, not left to `now()`. `CHECK (revoked_at IS NULL OR
        // revoked_at >= created_at)` is evaluated on INSERT, long before
        // `pinTimestamps` rewrites anything, so a row revoked in 2026-08 and
        // created "now" fails on the way in.
        createdAt: at(10),
      },
    ],
  });

  await verifyLoads();
  await pinTimestamps();

  const updates = await prisma.documentUpdate.count();
  const pending = await prisma.documentUpdate.count({ where: { documentId: seedId('doc', 'sync') } });
  console.log(
    `Seeded ${USERS.length} users, ${FOLDERS.length} folders, ${DOCUMENTS.length} documents, ` +
      `${updates} un-compacted updates (${pending} of them on "${DEMO_DOCUMENT}"), 3 versions, 2 share links.`,
  );
  console.log(`Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
