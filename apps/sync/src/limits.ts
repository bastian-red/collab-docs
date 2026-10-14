/**
 * Per-connection limits, in process memory.
 *
 * Not in Redis, and that is a decision rather than a shortcut: a socket lives on
 * exactly one replica for its whole life, so there is nothing to share and a
 * round trip per message would be the most expensive thing on the hot path.
 * See docs/SPECS.md section 4.4.
 */
import { DomainError } from '@docs/shared';

export interface LimitPolicy {
  /** Messages per minute, sliding window. */
  readonly messagesPerMinute: number;
  /** The largest single frame, in bytes. The large paste, not the keystroke. */
  readonly maxPayloadBytes: number;
}

const WINDOW_MS = 60_000;

/**
 * A sliding window over one connection's message timestamps.
 *
 * Sliding rather than fixed-bucket: a fixed minute bucket lets a client send the
 * whole allowance in the last second of one minute and again in the first second
 * of the next, which is twice the limit at the moment it matters most.
 */
export class ConnectionLimiter {
  private readonly stamps: number[] = [];

  constructor(private readonly policy: LimitPolicy) {}

  /**
   * Record a message and say whether it is allowed.
   *
   * **A refusal is not counted against the window.** A client that loops on
   * being refused would otherwise push its own timestamps forward forever and
   * lock itself out permanently instead of backing off -- turning a transient
   * overshoot into a connection that can never recover without a reconnect.
   */
  admit(now: number): boolean {
    this.evict(now);
    if (this.stamps.length >= this.policy.messagesPerMinute) return false;
    this.stamps.push(now);
    return true;
  }

  /** How many messages this connection could still send right now. */
  remaining(now: number): number {
    this.evict(now);
    return Math.max(0, this.policy.messagesPerMinute - this.stamps.length);
  }

  /** When the window will next admit a message, or `now` if it already would. */
  retryAt(now: number): number {
    this.evict(now);
    if (this.stamps.length < this.policy.messagesPerMinute) return now;
    // The oldest stamp is the one whose expiry frees a slot.
    return this.stamps[0]! + WINDOW_MS;
  }

  private evict(now: number): void {
    const cutoff = now - WINDOW_MS;
    // The array is append-only in time order, so everything expired is a prefix.
    let drop = 0;
    while (drop < this.stamps.length && this.stamps[drop]! <= cutoff) drop += 1;
    if (drop > 0) this.stamps.splice(0, drop);
  }
}

/**
 * The frame-size check.
 *
 * Before the update is applied, never after: the point is to refuse the
 * allocation, and a check that runs after the document has already grown is a
 * report rather than a limit.
 */
export function assertPayloadSize(bytes: number, policy: LimitPolicy): void {
  if (bytes > policy.maxPayloadBytes) {
    throw new DomainError(
      'TOO_LARGE',
      `That change is ${bytes} bytes, over the ${policy.maxPayloadBytes}-byte limit for a single message.`,
    );
  }
}

/**
 * The document ceiling (docs/SPECS.md 3.4).
 *
 * Measured against the ENCODED STATE, not the visible text. Without a ceiling
 * one client can grow a document until the replica cannot hold it, and every
 * other document on that replica dies with it.
 *
 * `incoming` is added to the current size rather than compared alone, because
 * the question is what the document would become, not what arrived.
 */
export function assertDocumentCeiling(
  currentBytes: number,
  incomingBytes: number,
  ceiling: number,
): void {
  const projected = currentBytes + incomingBytes;
  if (projected > ceiling) {
    throw new DomainError(
      'TOO_LARGE',
      `This document is at its ${ceiling}-byte limit. Split it before adding more.`,
    );
  }
}
