/**
 * When a version gets cut, and what number it takes.
 *
 * Pure, and it takes the clock as a parameter for the same reason
 * `shouldCompact` does: a default of `Date.now()` makes the interval branch
 * testable only by sleeping. See docs/SPECS.md section 5.1.
 */
import type { VersionKind } from '@docs/shared';

export interface VersionPolicy {
  /** At most one automatic version per document per this many seconds. */
  readonly intervalSeconds: number;
  /** Beyond this many rows the oldest AUTOMATIC versions are dropped (see prune.ts). */
  readonly maxPerDocument: number;
}

export function assertVersionPolicy(policy: VersionPolicy): void {
  if (!Number.isInteger(policy.intervalSeconds) || policy.intervalSeconds < 1) {
    throw new Error('VERSION_INTERVAL_SECONDS must be a positive integer.');
  }
  if (!Number.isInteger(policy.maxPerDocument) || policy.maxPerDocument < 1) {
    throw new Error('VERSION_MAX_PER_DOCUMENT must be a positive integer.');
  }
}

/** What the caller knows about the newest version already stored. */
export interface LastVersion {
  readonly createdAt: Date;
  /**
   * `documentFingerprint` of the state that version holds, not a hash of its
   * bytes. Two encodings of the same document differ byte for byte -- the update
   * format is not canonical, and the order of the clients in it follows whoever
   * wrote last -- so a byte hash would cut a "new" version every interval for a
   * document nobody had touched.
   */
  readonly fingerprint: string;
}

/**
 * Whether to cut an automatic version now.
 *
 * The order of the two refusals is deliberate. "Unchanged" is checked before
 * "too soon", so a document nobody is editing never cuts a version, however long
 * the process has been running. The other order would fill the panel with
 * identical entries for an idle document and then prune the labelled ones out
 * from under it.
 */
export function shouldCutVersion(
  last: LastVersion | null,
  currentFingerprint: string,
  policy: VersionPolicy,
  now: Date,
): boolean {
  // The first checkpoint of a document is always worth keeping: it is the only
  // state a restore could ever return to before anyone thinks to label one.
  if (last === null) return true;
  if (last.fingerprint === currentFingerprint) return false;
  return now.getTime() - last.createdAt.getTime() >= policy.intervalSeconds * 1000;
}

/**
 * The next version number for a document.
 *
 * Dense and per document, which is what `UNIQUE (document_id, n)` enforces. Two
 * writers racing here both compute the same number and one of them loses on that
 * constraint; the caller retries. That is the intended behaviour and the reason
 * the number is not taken from a global sequence: a user-visible "version 7" that
 * skips to 9 because another document was saved in between reads as data loss.
 */
export function nextVersionNumber(highest: number | null): number {
  return (highest ?? 0) + 1;
}

/** `AUTO` unless a person asked for it, which is the only thing `kind` means. */
export function kindFor(label: string | null): VersionKind {
  return label === null ? 'AUTO' : 'MANUAL';
}
