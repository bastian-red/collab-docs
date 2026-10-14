/**
 * Which versions to drop when a document has too many.
 *
 * Pure: it takes the rows and returns the ids to delete, so the rule is a test
 * rather than a DELETE with a subquery in it that nobody can read.
 * See docs/SPECS.md section 5.1.
 */
import type { VersionKind } from '@docs/shared';

import type { VersionPolicy } from './policy.js';

export interface PrunableVersion {
  readonly id: string;
  readonly n: number;
  readonly kind: VersionKind;
}

/**
 * The ids to delete, oldest first.
 *
 * **A labelled version is never pruned.** Not "pruned last", never. Deleting the
 * thing somebody deliberately named is the one behaviour nobody forgives, and it
 * would happen exactly when the history is most valuable: on the document being
 * edited hardest, whose automatic versions push the count over the cap fastest.
 *
 * The consequence is accepted and is the reason this returns a list rather than
 * enforcing a number: a document with more manual versions than
 * `maxPerDocument` stays over the cap. It is bounded by how many times a person
 * pressed a button, which is a bound.
 *
 * Ordered by `n` rather than by `createdAt`. `n` is allocated by the database
 * under a unique constraint; two rows can share a millisecond but not a number.
 */
export function planPrune(versions: readonly PrunableVersion[], policy: VersionPolicy): string[] {
  if (versions.length <= policy.maxPerDocument) return [];

  const ordered = [...versions].sort((a, b) => a.n - b.n);
  const excess = ordered.length - policy.maxPerDocument;
  const doomed: string[] = [];

  for (const version of ordered) {
    if (doomed.length === excess) break;
    if (version.kind === 'MANUAL') continue;
    doomed.push(version.id);
  }

  return doomed;
}

/** What the panel would show after a prune, for asserting on the shape rather than the ids. */
export function survivors(
  versions: readonly PrunableVersion[],
  policy: VersionPolicy,
): PrunableVersion[] {
  const doomed = new Set(planPrune(versions, policy));
  return versions.filter((version) => !doomed.has(version.id));
}
