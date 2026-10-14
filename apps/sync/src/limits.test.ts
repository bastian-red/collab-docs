import { isDomainError } from '@docs/shared';
import { describe, expect, it } from 'vitest';

import {
  ConnectionLimiter,
  assertDocumentCeiling,
  assertPayloadSize,
  type LimitPolicy,
} from './limits.js';

const POLICY: LimitPolicy = { messagesPerMinute: 5, maxPayloadBytes: 1024 };
const T0 = 1_800_000_000_000;

function code(fn: () => unknown): string {
  try {
    fn();
    return 'did not throw';
  } catch (error) {
    return isDomainError(error) ? error.code : `not a DomainError: ${String(error)}`;
  }
}

describe('ConnectionLimiter', () => {
  it('admits up to the limit and then refuses', () => {
    const limiter = new ConnectionLimiter(POLICY);
    for (let i = 0; i < 5; i += 1) expect(limiter.admit(T0 + i)).toBe(true);
    expect(limiter.admit(T0 + 5)).toBe(false);
  });

  it('does not count a refusal against the window', () => {
    // The property that matters. A client looping on refusals would otherwise
    // push its own timestamps forward forever and never recover without a
    // reconnect -- a transient overshoot becoming a permanent lockout.
    const limiter = new ConnectionLimiter(POLICY);
    for (let i = 0; i < 5; i += 1) limiter.admit(T0);
    for (let i = 0; i < 1000; i += 1) expect(limiter.admit(T0 + 1)).toBe(false);
    // One minute after the ORIGINAL five, not after the thousand refusals.
    expect(limiter.admit(T0 + 60_001)).toBe(true);
  });

  it('slides rather than resetting on a fixed boundary', () => {
    // A fixed minute bucket admits the whole allowance in the last second of one
    // minute and again in the first second of the next: twice the limit at the
    // moment it matters most. The window here instead frees one slot as each
    // individual stamp ages out.
    //
    // Values computed against the implementation, not reasoned about: five
    // stamps at T0+59_000..59_004, so the first frees a slot at 119_000 and not
    // one millisecond earlier.
    const limiter = new ConnectionLimiter(POLICY);
    for (let i = 0; i < 5; i += 1) limiter.admit(T0 + 59_000 + i);
    expect(limiter.admit(T0 + 60_000)).toBe(false);
    expect(limiter.admit(T0 + 118_999)).toBe(false);
    expect(limiter.admit(T0 + 119_000)).toBe(true);
  });

  it('frees exactly one slot as each stamp expires', () => {
    const limiter = new ConnectionLimiter(POLICY);
    for (let i = 0; i < 5; i += 1) limiter.admit(T0 + i * 1000);
    expect(limiter.remaining(T0 + 5000)).toBe(0);
    // The first stamp (T0) expires at T0 + 60_000 inclusive.
    expect(limiter.remaining(T0 + 60_000)).toBe(1);
    expect(limiter.remaining(T0 + 61_000)).toBe(2);
  });

  it('reports when the window will next admit', () => {
    const limiter = new ConnectionLimiter(POLICY);
    expect(limiter.retryAt(T0)).toBe(T0);
    for (let i = 0; i < 5; i += 1) limiter.admit(T0 + i);
    expect(limiter.retryAt(T0 + 10)).toBe(T0 + 60_000);
  });

  it('keeps its memory bounded by the limit, not by traffic', () => {
    // The stamps array is the whole state, and it is what a long-lived socket
    // would leak. `remaining` is never negative and never above the limit at any
    // point during ten thousand messages, and once every stamp has aged out the
    // window is empty again -- which is only true if eviction actually removes
    // them rather than letting the array grow behind an index.
    const limiter = new ConnectionLimiter({ ...POLICY, messagesPerMinute: 3 });
    // 2000, not 10_000: this runs in the gate lane, whose whole budget is two
    // seconds, and the invariant does not get truer with five times the loop.
    const messages = 2000;
    for (let i = 0; i < messages; i += 1) {
      limiter.admit(T0 + i * 100);
      const left = limiter.remaining(T0 + i * 100);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(3);
    }
    expect(limiter.remaining(T0 + messages * 100)).toBe(0);
    expect(limiter.remaining(T0 + messages * 100 + 60_001)).toBe(3);
  });
});

describe('assertPayloadSize', () => {
  it('allows a frame at exactly the limit', () => {
    expect(() => assertPayloadSize(1024, POLICY)).not.toThrow();
  });

  it('refuses one byte over, as TOO_LARGE', () => {
    expect(code(() => assertPayloadSize(1025, POLICY))).toBe('TOO_LARGE');
  });
});

describe('assertDocumentCeiling', () => {
  it('measures what the document would become, not what arrived', () => {
    // Comparing the incoming update alone would let a document grow without
    // bound one small update at a time, which is exactly how it grows.
    expect(code(() => assertDocumentCeiling(1000, 25, 1024))).toBe('TOO_LARGE');
    expect(() => assertDocumentCeiling(1000, 24, 1024)).not.toThrow();
  });

  it('allows a document sitting exactly at the ceiling to receive nothing', () => {
    expect(() => assertDocumentCeiling(1024, 0, 1024)).not.toThrow();
    expect(code(() => assertDocumentCeiling(1024, 1, 1024))).toBe('TOO_LARGE');
  });
});
