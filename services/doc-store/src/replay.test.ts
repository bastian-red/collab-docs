import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { sameState } from './equality.js';
import { applyLog } from './replay.js';
import type { DocumentSnapshot, LoggedUpdate } from './ports.js';
import { DOCUMENT_FRAGMENT, emptyDocumentState, encodeState } from './state.js';

/** Deterministic PRNG. A seed that is printed on failure beats an irreproducible one. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insertParagraph(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

/** Record a log the way the sync server would: one row per update event. */
function recordLog(build: (doc: Y.Doc) => void): {
  snapshot: DocumentSnapshot;
  log: LoggedUpdate[];
  reference: Uint8Array;
} {
  const doc = new Y.Doc();
  const log: LoggedUpdate[] = [];
  let seq = 0n;
  doc.on('update', (update: Uint8Array) => {
    seq += 1n;
    log.push({ seq, update });
  });
  build(doc);
  const reference = encodeState(doc);
  doc.destroy();
  return {
    snapshot: { state: emptyDocumentState(), stateSeq: 0n, nextSeq: seq + 1n },
    log,
    reference,
  };
}

function replayInto(
  snapshot: DocumentSnapshot,
  log: readonly LoggedUpdate[],
): { state: Uint8Array; appliedSeq: bigint } {
  const doc = new Y.Doc();
  const loaded = applyLog(doc, snapshot, log);
  const state = encodeState(doc);
  doc.destroy();
  return { state, appliedSeq: loaded.appliedSeq };
}

const build = (doc: Y.Doc) => {
  insertParagraph(doc, 'The nightly batch has been the reconciliation path since 2019.');
  insertParagraph(doc, 'The schema stays. The reconciliation rules stay.');
  insertParagraph(doc, 'We keep the batch running in parallel for two full quarters.');
  insertParagraph(doc, 'Rollout: shadow writes, no reads.');
};

describe('applyLog', () => {
  it('reconstructs the document from an empty checkpoint plus its log', () => {
    const { snapshot, log, reference } = recordLog(build);
    expect(log.length).toBeGreaterThan(3);
    const { state, appliedSeq } = replayInto(snapshot, log);
    expect(sameState(state, reference)).toBe(true);
    expect(appliedSeq).toBe(BigInt(log.length));
  });

  it('is idempotent: the same log applied twice is the same document', () => {
    // This is the property the crash window depends on. See docs/SPECS.md 3.2.
    const { snapshot, log, reference } = recordLog(build);
    const { state } = replayInto(snapshot, [...log, ...log]);
    expect(sameState(state, reference)).toBe(true);
  });

  it('is commutative: a shuffled log is the same document', () => {
    const { snapshot, log, reference } = recordLog(build);
    const random = mulberry32(0xc0ffee);
    const shuffled = [...log];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    expect(shuffled.map((e) => e.seq)).not.toEqual(log.map((e) => e.seq));
    expect(sameState(replayInto(snapshot, shuffled).state, reference)).toBe(true);
  });

  it('survives shuffling AND duplication together, which is the real crash shape', () => {
    // After a crash between the checkpoint write and the log truncation, the
    // load replays rows that are already inside the checkpoint. In a two-replica
    // deployment they can also arrive out of order. Both at once.
    const { snapshot, log, reference } = recordLog(build);
    const random = mulberry32(42);
    const messy: LoggedUpdate[] = [];
    for (const entry of log) {
      messy.push(entry);
      if (random() < 0.5) messy.push(entry);
    }
    for (let i = messy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [messy[i], messy[j]] = [messy[j]!, messy[i]!];
    }
    expect(sameState(replayInto(snapshot, messy).state, reference)).toBe(true);
  });

  it('reports the HIGHEST seq applied, not the last one in the array', () => {
    // The next compaction truncates everything at or below appliedSeq. If a
    // shuffled log made this the last element rather than the maximum, the
    // truncation would delete rows the checkpoint does not contain, and the
    // document would silently lose them. This is the one bug in the design that
    // produces a wrong document rather than a slow one.
    const { snapshot, log } = recordLog(build);
    const reversed = [...log].reverse();
    expect(replayInto(snapshot, reversed).appliedSeq).toBe(BigInt(log.length));
  });

  it('applies a non-empty checkpoint and only the log above it', () => {
    const { snapshot, log, reference } = recordLog(build);
    const half = Math.floor(log.length / 2);

    // Compact the first half into a checkpoint.
    const doc = new Y.Doc();
    applyLog(doc, snapshot, log.slice(0, half));
    const checkpoint: DocumentSnapshot = {
      state: encodeState(doc),
      stateSeq: BigInt(half),
      nextSeq: BigInt(log.length + 1),
    };
    doc.destroy();

    const { state, appliedSeq } = replayInto(checkpoint, log.slice(half));
    expect(sameState(state, reference)).toBe(true);
    expect(appliedSeq).toBe(BigInt(log.length));
  });

  it('applies everything in one transaction, so hydrating fires one update event', () => {
    // Without the single transact, a document with 200 pending rows fires the
    // append listener 200 times and writes all 200 straight back to the log,
    // which grows without bound on every reload.
    const { snapshot, log } = recordLog(build);
    const doc = new Y.Doc();
    let events = 0;
    doc.on('update', () => {
      events += 1;
    });
    applyLog(doc, snapshot, log);
    doc.destroy();
    expect(events).toBe(1);
  });

  it('tags the load with an origin the append listener can recognise', () => {
    // The listener has to tell "a client typed this" from "this document is
    // being loaded". Without the origin it cannot, and every load re-appends
    // everything it just read.
    const { snapshot, log } = recordLog(build);
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    doc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin));
    applyLog(doc, snapshot, log);
    doc.destroy();
    expect(origins).toEqual(['doc-store:load']);
  });
});
