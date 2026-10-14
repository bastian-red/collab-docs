import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentFingerprint } from './equality.js';
import { DOCUMENT_FRAGMENT } from './state.js';

/**
 * The headline claim of this project, asserted rather than cited.
 *
 * "Several people edit one document at once and everybody ends up seeing the
 * same thing" is a property of Yjs, not of this codebase. A repo that imports
 * Yjs has not demonstrated it; a repo that runs N clients through a randomised
 * delivery schedule and compares the results has.
 *
 * Everything here is plain `Y.Doc`s. No sockets, no database, no Hocuspocus --
 * which is why the strongest test in the project runs in the free lane in
 * milliseconds and executes on every commit.
 *
 * The delivery model is deliberately hostile and mirrors the real deployment:
 * updates are duplicated (a replica re-sends after a reconnect), reordered (two
 * sync replicas relay through Redis independently), and delayed arbitrarily (a
 * client was offline). None of that is allowed to change where the document
 * lands.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['ledger', 'batch', 'stream', 'shadow', 'tenant', 'rollout', 'audit', 'replica'];

/** One in-flight update: who produced it, and the bytes. */
interface Envelope {
  readonly from: number;
  readonly update: Uint8Array;
}

class Client {
  readonly doc = new Y.Doc();
  readonly outbox: Uint8Array[] = [];

  constructor(readonly index: number) {
    // Pinned, and this is not cosmetic. Yjs assigns every Y.Doc a RANDOM
    // clientID at construction and uses it to break ties between concurrent
    // insertions at the same position. Leaving it random means the seed does not
    // determine the run: the same seed produces a different document each time,
    // and a failure cannot be reproduced by pasting the seed back -- which is
    // the entire reason for having one. Caught by the last test in this file,
    // which is here precisely to keep that property honest.
    this.doc.clientID = index + 1;

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Updates that arrived from another client must not be re-broadcast as
      // this client's own, or the test would be measuring an echo rather than a
      // merge.
      if (origin === 'remote') return;
      this.outbox.push(update);
    });
  }

  edit(random: () => number): void {
    const fragment = this.doc.getXmlFragment(DOCUMENT_FRAGMENT);
    const roll = random();

    if (roll < 0.55 || fragment.length === 0) {
      const paragraph = new Y.XmlElement('paragraph');
      const word = WORDS[Math.floor(random() * WORDS.length)]!;
      paragraph.insert(0, [new Y.XmlText(`${word} from client ${this.index}`)]);
      fragment.insert(Math.floor(random() * (fragment.length + 1)), [paragraph]);
      return;
    }

    if (roll < 0.8) {
      const target = fragment.get(Math.floor(random() * fragment.length));
      if (target instanceof Y.XmlElement) {
        const text = target.get(0);
        if (text instanceof Y.XmlText) {
          text.insert(Math.min(text.length, Math.floor(random() * (text.length + 1))), '!');
          return;
        }
      }
      return;
    }

    fragment.delete(Math.floor(random() * fragment.length), 1);
  }

  receive(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, 'remote');
  }

  destroy(): void {
    this.doc.destroy();
  }
}

/**
 * Every client's logical state must be identical.
 *
 * Via `documentFingerprint`, not via "the diff between them is empty". See
 * equality.ts: the diff always carries the whole delete set, so on any run
 * containing a deletion -- which is most of them -- it is never empty and the
 * check would report divergence for documents that have converged. That is
 * exactly what the first version of this file did, and the 178 bytes it
 * complained about were tombstones.
 */
function converged(clients: readonly Client[]): boolean {
  const first = documentFingerprint(clients[0]!.doc);
  return clients.every((client) => documentFingerprint(client.doc) === first);
}

function textOf(client: Client): string {
  return client.doc.getXmlFragment(DOCUMENT_FRAGMENT).toString();
}

/**
 * One randomised run.
 *
 * Returns the shared text so the caller can assert every client agrees on it,
 * which is a strictly stronger statement than "their state vectors match": two
 * docs can hold the same items and still render differently if the traversal
 * order were not deterministic.
 */
function run(seed: number, clientCount: number, rounds: number): string[] {
  const random = mulberry32(seed);
  const clients = Array.from({ length: clientCount }, (_, i) => new Client(i));
  const inFlight: Envelope[] = [];

  try {
    for (let round = 0; round < rounds; round += 1) {
      // Somebody types.
      const author = clients[Math.floor(random() * clients.length)]!;
      author.edit(random);
      for (const update of author.outbox.splice(0)) {
        inFlight.push({ from: author.index, update });
      }

      // The network delivers an arbitrary in-flight update to an arbitrary
      // client, sometimes twice, sometimes not yet at all.
      if (inFlight.length > 0 && random() < 0.75) {
        const pick = Math.floor(random() * inFlight.length);
        const envelope = inFlight[pick]!;
        const target = clients[Math.floor(random() * clients.length)]!;
        if (target.index !== envelope.from) target.receive(envelope.update);
        // A duplicate delivery, which a reconnecting replica really does send.
        if (random() < 0.25 && target.index !== envelope.from) target.receive(envelope.update);
        if (random() < 0.6) inFlight.splice(pick, 1);
      }
    }

    // The partition heals: everything still in flight, plus every client's full
    // state, reaches everybody. This is the reconnect.
    for (const envelope of inFlight) {
      for (const client of clients)
        if (client.index !== envelope.from) client.receive(envelope.update);
    }
    for (const source of clients) {
      const state = Y.encodeStateAsUpdate(source.doc);
      for (const target of clients) if (target !== source) target.receive(state);
    }

    expect(converged(clients), `seed ${seed}: clients did not converge`).toBe(true);
    return clients.map(textOf);
  } finally {
    for (const client of clients) client.destroy();
  }
}

describe('convergence under concurrent editing', () => {
  // Fixed seeds, not Math.random: a failure has to be reproducible by pasting
  // the seed back, and a flaky test that cannot be reproduced gets deleted
  // rather than fixed.
  const SEEDS = [1, 7, 42, 1337, 20260825, 0xdecafbad, 999983, 31337];

  // Round counts are tuned to the gate lane's budget, not chosen for drama. The
  // property is what is being tested, and 150 rounds across 5 clients already
  // produces hundreds of concurrent, interleaved, duplicated and delayed
  // deliveries. Eight seeds beat one long run: independent schedules cover more
  // shapes than a single schedule run four times as long.
  for (const seed of SEEDS) {
    it(`seed ${seed}: five clients reach the same document`, () => {
      const texts = run(seed, 5, 150);
      const [first, ...rest] = texts;
      for (const text of rest) expect(text).toBe(first);
    });
  }

  it('two clients, a long run', () => {
    const texts = run(2026, 2, 400);
    expect(new Set(texts).size).toBe(1);
  });

  it('nine clients, which is more than any of them ever see at once', () => {
    const texts = run(9091, 9, 180);
    expect(new Set(texts).size).toBe(1);
  });

  it('actually produced a non-trivial document, so agreement is not agreement on nothing', () => {
    // Without this, a bug that dropped every edit would make every client agree
    // on an empty document and the whole suite above would pass.
    const texts = run(42, 5, 150);
    expect(texts[0]!.length).toBeGreaterThan(200);
    expect(texts[0]).toContain('client');
  });

  it('the same seed produces the same document twice, so a failure is reproducible', () => {
    expect(run(1337, 5, 150)).toEqual(run(1337, 5, 150));
  });
});
