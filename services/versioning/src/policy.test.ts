import { describe, expect, it } from 'vitest';

import {
  assertVersionPolicy,
  kindFor,
  nextVersionNumber,
  shouldCutVersion,
  type VersionPolicy,
} from './policy.js';

const POLICY: VersionPolicy = { intervalSeconds: 300, maxPerDocument: 50 };
const NOW = new Date('2026-03-09T12:00:00.000Z');

function ago(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

describe('assertVersionPolicy', () => {
  it('refuses values that would make the cadence meaningless', () => {
    expect(() => assertVersionPolicy(POLICY)).not.toThrow();
    expect(() => assertVersionPolicy({ ...POLICY, intervalSeconds: 0 })).toThrow(
      /VERSION_INTERVAL_SECONDS/u,
    );
    expect(() => assertVersionPolicy({ ...POLICY, intervalSeconds: 1.5 })).toThrow(
      /VERSION_INTERVAL_SECONDS/u,
    );
    expect(() => assertVersionPolicy({ ...POLICY, maxPerDocument: 0 })).toThrow(
      /VERSION_MAX_PER_DOCUMENT/u,
    );
  });
});

describe('shouldCutVersion', () => {
  it('cuts the first version of a document unconditionally', () => {
    // Before this there is nothing to restore to.
    expect(shouldCutVersion(null, 'fp-a', POLICY, NOW)).toBe(true);
  });

  it('does not cut a version of a document nobody changed, however long it has been', () => {
    const last = { createdAt: ago(86_400), fingerprint: 'fp-a' };
    expect(shouldCutVersion(last, 'fp-a', POLICY, NOW)).toBe(false);
  });

  it('does not cut a second version inside the interval', () => {
    const last = { createdAt: ago(299), fingerprint: 'fp-a' };
    expect(shouldCutVersion(last, 'fp-b', POLICY, NOW)).toBe(false);
  });

  it('cuts once the interval has passed and the text moved', () => {
    const last = { createdAt: ago(300), fingerprint: 'fp-a' };
    expect(shouldCutVersion(last, 'fp-b', POLICY, NOW)).toBe(true);
  });

  it('checks unchanged before too-soon, so an idle document never fills the panel', () => {
    // The other order cuts an identical version every interval for a document
    // nobody is editing, and those then prune the labelled ones out from under
    // it.
    const idle = { createdAt: ago(10_000), fingerprint: 'fp-a' };
    expect(shouldCutVersion(idle, 'fp-a', POLICY, NOW)).toBe(false);
  });

  it('treats the interval boundary as due, not as one tick short', () => {
    expect(shouldCutVersion({ createdAt: ago(300), fingerprint: 'x' }, 'y', POLICY, NOW)).toBe(
      true,
    );
    expect(shouldCutVersion({ createdAt: ago(299.999), fingerprint: 'x' }, 'y', POLICY, NOW)).toBe(
      false,
    );
  });
});

describe('nextVersionNumber', () => {
  it('starts at 1 and stays dense', () => {
    expect(nextVersionNumber(null)).toBe(1);
    expect(nextVersionNumber(1)).toBe(2);
    expect(nextVersionNumber(49)).toBe(50);
  });

  it('gives two racing writers the same number, which UNIQUE (document_id, n) then settles', () => {
    // Deliberate. A global sequence would avoid the collision and produce a
    // panel that jumps from "version 7" to "version 9" because another document
    // was saved in between, which reads as a version having been deleted.
    expect(nextVersionNumber(7)).toBe(nextVersionNumber(7));
  });
});

describe('kindFor', () => {
  it('is MANUAL exactly when a person supplied a label', () => {
    expect(kindFor(null)).toBe('AUTO');
    expect(kindFor('before the rewrite')).toBe('MANUAL');
  });
});
