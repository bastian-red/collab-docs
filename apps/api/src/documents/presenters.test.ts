import {
  documentDetailSchema,
  documentSummarySchema,
  folderSchema,
  searchHitSchema,
  shareLinkSchema,
  versionSummarySchema,
} from '@docs/shared';
import { describe, expect, it } from 'vitest';

import {
  HEADLINE_START,
  HEADLINE_STOP,
  presentDocumentDetail,
  presentDocumentSummary,
  presentFolder,
  presentSearchHit,
  presentShareLink,
  presentVersion,
  splitSnippet,
  type DocumentStateRow,
} from './presenters';

const DOC_ID = 'clq1234567890abcdefghij';
const USER_ID = 'clqzzzzzzzzzzzzzzzzzzz';
const AT = new Date('2026-08-26T09:30:00.000Z');

function documentRow(overrides: Partial<DocumentStateRow> = {}): DocumentStateRow {
  return {
    id: DOC_ID,
    title: 'Roadmap',
    folderId: 'clqfolder1234567890abc',
    folder: { name: 'Planning' },
    updatedAt: AT,
    members: [{ role: 'OWNER', user: { id: USER_ID, name: 'Ada' } }],
    stateSeq: 12n,
    nextSeq: 19n,
    state: new Uint8Array([0, 0, 7]),
    ...overrides,
  };
}

describe('presentDocumentSummary', () => {
  it('is what the shared schema parses', () => {
    const wire = presentDocumentSummary(documentRow(), 'OWNER');
    expect(() => documentSummarySchema.parse(wire)).not.toThrow();
    expect(wire.folderName).toBe('Planning');
    expect(wire.members).toEqual([{ id: USER_ID, name: 'Ada', role: 'OWNER' }]);
  });

  it('reports a root document as having no folder', () => {
    const wire = presentDocumentSummary(documentRow({ folderId: null, folder: null }), 'EDITOR');
    expect(wire.folderId).toBeNull();
    expect(wire.folderName).toBeNull();
    expect(() => documentSummarySchema.parse(wire)).not.toThrow();
  });

  it("carries the caller's own role, not the owner's", () => {
    // The row's member list is the whole document's; `role` is the caller's. A
    // presenter that read it off `members[0]` would tell a viewer they are the
    // owner, and the web app hides buttons by it.
    expect(presentDocumentSummary(documentRow(), 'VIEWER').role).toBe('VIEWER');
  });
});

describe('presentDocumentDetail', () => {
  /**
   * The failure this pins: `JSON.stringify(12n)` throws
   * `TypeError: Do not know how to serialize a BigInt`, so a presenter that
   * passed the Prisma value straight through would take down every document
   * request rather than one field.
   */
  it('puts seq values on the wire as strings', () => {
    const wire = presentDocumentDetail(documentRow(), 'OWNER');
    expect(wire.stateSeq).toBe('12');
    expect(wire.nextSeq).toBe('19');
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it('round-trips through the schema back to bigints', () => {
    const parsed = documentDetailSchema.parse(presentDocumentDetail(documentRow(), 'OWNER'));
    expect(parsed.stateSeq).toBe(12n);
    expect(parsed.nextSeq).toBe(19n);
  });

  /**
   * A seq past 2^53 is the case a `Number` would lose silently, in the one field
   * the persistence design is read from. Computed rather than recalled:
   * Number.MAX_SAFE_INTEGER is 9007199254740991.
   */
  it('does not lose precision above 2^53', () => {
    const huge = 9_007_199_254_740_993n;
    const wire = presentDocumentDetail(documentRow({ nextSeq: huge }), 'OWNER');
    expect(wire.nextSeq).toBe('9007199254740993');
    expect(documentDetailSchema.parse(wire).nextSeq).toBe(huge);
  });

  it('reports the checkpoint size, which is what DOCUMENT_MAX_BYTES bounds', () => {
    expect(presentDocumentDetail(documentRow(), 'OWNER').stateBytes).toBe(3);
  });
});

describe('presentFolder', () => {
  it('is what the shared schema parses', () => {
    const wire = presentFolder({
      id: 'clqfolder1234567890abc',
      name: 'Planning',
      parentId: null,
      _count: { documents: 4 },
    });
    expect(folderSchema.parse(wire)).toEqual(wire);
  });
});

describe('presentVersion', () => {
  it('is what the shared schema parses', () => {
    const wire = presentVersion({
      id: 'clqversion1234567890ab',
      n: 3,
      kind: 'MANUAL',
      label: 'Before the rewrite',
      author: { name: 'Ada' },
      createdAt: AT,
      state: new Uint8Array(11),
    });
    expect(versionSummarySchema.parse(wire)).toEqual(wire);
    expect(wire.bytes).toBe(11);
  });

  // An automatic version has no author when the person who triggered the
  // compaction has since been deleted, and losing a name must never mean losing
  // the version.
  it('survives a deleted author', () => {
    const wire = presentVersion({
      id: 'clqversion1234567890ab',
      n: 1,
      kind: 'AUTO',
      label: null,
      author: null,
      createdAt: AT,
      state: new Uint8Array(2),
    });
    expect(wire.authorName).toBeNull();
    expect(() => versionSummarySchema.parse(wire)).not.toThrow();
  });
});

describe('presentShareLink', () => {
  it('builds the URL the web app serves, from APP_BASE_URL', () => {
    const wire = presentShareLink(
      {
        id: 'clqlink12345678901234',
        documentId: DOC_ID,
        token: 'abcdefghijklmnopqrstuvwx',
        role: 'VIEWER',
        expiresAt: AT,
        revokedAt: null,
        createdAt: AT,
      },
      'http://localhost:3000',
    );
    expect(wire.url).toBe(`http://localhost:3000/d/${DOC_ID}?share=abcdefghijklmnopqrstuvwx`);
    // The extra `url` field is additive; the shared schema still parses the rest.
    expect(() => shareLinkSchema.parse(wire)).not.toThrow();
  });
});

describe('splitSnippet', () => {
  it('turns the markers into segments, and never emits HTML', () => {
    expect(splitSnippet(`a ${HEADLINE_START}match${HEADLINE_STOP} b`)).toEqual([
      { text: 'a ', match: false },
      { text: 'match', match: true },
      { text: ' b', match: false },
    ]);
  });

  it('handles several matches', () => {
    expect(splitSnippet('[[one]] and [[two]]')).toEqual([
      { text: 'one', match: true },
      { text: ' and ', match: false },
      { text: 'two', match: true },
    ]);
  });

  /**
   * `ts_headline` can cut a fragment in the middle of a highlight. Dropping the
   * tail would silently delete text from a search result, which is worse than a
   * stray `[[`.
   */
  it('keeps text after an unpaired start marker', () => {
    expect(splitSnippet('a [[b')).toEqual([{ text: 'a [[b', match: false }]);
    expect(splitSnippet('a ]] b')).toEqual([{ text: 'a ]] b', match: false }]);
  });

  it('leaves a document that literally contains angle brackets alone', () => {
    // The reason the markers are not `<b>`: this text is somebody's document.
    expect(splitSnippet('use <script> carefully')).toEqual([
      { text: 'use <script> carefully', match: false },
    ]);
  });

  it('is empty for an empty snippet', () => {
    expect(splitSnippet('')).toEqual([]);
  });
});

describe('presentSearchHit', () => {
  it('is what the shared schema parses', () => {
    const wire = presentSearchHit({
      id: DOC_ID,
      title: 'Roadmap',
      snippet: 'a [[match]] b',
      rank: 0.6079271,
      updated_at: AT,
    });
    expect(searchHitSchema.parse(wire)).toEqual(wire);
    expect(wire.updatedAt).toBe('2026-08-26T09:30:00.000Z');
  });
});
