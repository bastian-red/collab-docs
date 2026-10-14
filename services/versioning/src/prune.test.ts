import { describe, expect, it } from 'vitest';

import type { VersionPolicy } from './policy.js';
import { planPrune, survivors, type PrunableVersion } from './prune.js';

const POLICY: VersionPolicy = { intervalSeconds: 300, maxPerDocument: 5 };

function auto(n: number): PrunableVersion {
  return { id: `v${n}`, n, kind: 'AUTO' };
}

function manual(n: number): PrunableVersion {
  return { id: `v${n}`, n, kind: 'MANUAL' };
}

function autos(count: number): PrunableVersion[] {
  return Array.from({ length: count }, (_unused, index) => auto(index + 1));
}

describe('planPrune', () => {
  it('drops nothing while the document is under the cap', () => {
    expect(planPrune(autos(5), POLICY)).toEqual([]);
    expect(planPrune([], POLICY)).toEqual([]);
  });

  it('drops the oldest automatic versions once the cap is passed', () => {
    expect(planPrune(autos(8), POLICY)).toEqual(['v1', 'v2', 'v3']);
  });

  it('never drops a version somebody labelled', () => {
    // The one behaviour nobody forgives. It would happen exactly on the document
    // being edited hardest, whose automatic versions push the count over the cap
    // fastest, which is also the document whose history is worth most.
    const rows = [manual(1), auto(2), auto(3), manual(4), auto(5), auto(6), auto(7), auto(8)];
    expect(planPrune(rows, POLICY)).toEqual(['v2', 'v3', 'v5']);
    expect(survivors(rows, POLICY).map((row) => row.id)).toEqual(['v1', 'v4', 'v6', 'v7', 'v8']);
  });

  it('leaves the document over the cap rather than deleting a labelled version', () => {
    // Accepted consequence, stated in SPECS 5.1. The excess is bounded by how
    // many times a person pressed Save, which is a bound.
    const rows = [manual(1), manual(2), manual(3), manual(4), manual(5), manual(6), auto(7)];
    expect(planPrune(rows, POLICY)).toEqual(['v7']);
    expect(survivors(rows, POLICY).length).toBe(6);
  });

  it('deletes nothing when every version over the cap is labelled', () => {
    const rows = [manual(1), manual(2), manual(3), manual(4), manual(5), manual(6), manual(7)];
    expect(planPrune(rows, POLICY)).toEqual([]);
  });

  it('drops exactly the excess and not one more', () => {
    const rows = autos(6);
    expect(planPrune(rows, POLICY)).toHaveLength(1);
    expect(survivors(rows, POLICY)).toHaveLength(POLICY.maxPerDocument);
  });

  it('orders by n, not by the order the rows arrived in', () => {
    // Two rows can share a millisecond; they cannot share an n, because
    // UNIQUE (document_id, n) says so. Sorting by createdAt would make the
    // choice of which version to delete depend on a tie-break nothing controls.
    const shuffled = [auto(7), auto(3), auto(1), auto(8), auto(2), auto(6), auto(4), auto(5)];
    expect(planPrune(shuffled, POLICY)).toEqual(['v1', 'v2', 'v3']);
  });

  it('does not mutate the array it was given', () => {
    const rows = [auto(3), auto(1), auto(2), auto(6), auto(5), auto(4)];
    const before = rows.map((row) => row.id);
    planPrune(rows, POLICY);
    expect(rows.map((row) => row.id)).toEqual(before);
  });

  it('keeps the newest maxPerDocument rows for an all-automatic history', () => {
    const rows = autos(50);
    const kept = survivors(rows, { ...POLICY, maxPerDocument: 10 }).map((row) => row.n);
    expect(kept).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
  });
});
