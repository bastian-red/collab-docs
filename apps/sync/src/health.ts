/**
 * `/health` for the sync server.
 *
 * Three checks, and the third is the one no ordinary HTTP probe can substitute
 * for. A replica whose Redis SUBSCRIBER has silently stopped receiving serves
 * its own sockets perfectly: its clients converge with each other, its writes
 * reach Postgres, and `PING` answers in a millisecond. What it no longer does is
 * relay, and from a user's seat that looks like the other person simply stopped
 * typing. So the probe publishes a nonce and waits for its own subscriber to
 * hand it back. See docs/SPECS.md section 10.
 */
import { HEALTH_PROBE_CHANNEL, type Health, type HealthCheck } from '@docs/shared';
import type { Redis } from 'ioredis';

export interface HealthInputs {
  readonly version: string;
  readonly startedAt: number;
  query: () => Promise<unknown>;
  readonly redis: Redis;
  readonly probeSubscriber: Redis;
  counts: () => { connections: number; documents: number };
  readonly now?: () => number;
  /** Bounds the pub/sub probe. Below any sane HTTP client timeout, on purpose. */
  readonly probeTimeoutMs?: number;
  readonly nonce?: () => string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 1500;

async function timed(
  name: string,
  run: () => Promise<unknown>,
  now: () => number,
): Promise<HealthCheck> {
  const started = now();
  try {
    await run();
    return { name, status: 'ok', latencyMs: Math.round(now() - started), detail: null };
  } catch (error) {
    // The MESSAGE, never the stack. This body is public, and a stack carries
    // absolute paths and library versions.
    return {
      name,
      status: 'fail',
      latencyMs: Math.round(now() - started),
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

/**
 * Publish a nonce and wait for this replica's own subscriber to deliver it.
 *
 * The subscription is opened at boot, not here: subscribing per probe would
 * measure `SUBSCRIBE` rather than the delivery path, and a subscriber that has
 * gone deaf since boot is precisely the failure being looked for.
 *
 * The listener is always removed, including on the timeout path. Without that,
 * a replica whose Redis is slow accumulates one listener per probe, hits
 * `MaxListenersExceededWarning` at eleven, and then leaks quietly.
 */
export async function probePubSub(
  redis: Redis,
  subscriber: Redis,
  nonce: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const listener = (channel: string, message: string): void => {
      if (channel !== HEALTH_PROBE_CHANNEL || message !== nonce) return;
      finish(null);
    };

    const timer = setTimeout(() => {
      finish(
        new Error(`No pub/sub round trip within ${timeoutMs}ms; this replica is not relaying`),
      );
    }, timeoutMs);

    function finish(error: Error | null): void {
      clearTimeout(timer);
      subscriber.off('message', listener);
      if (error === null) resolve();
      else reject(error);
    }

    subscriber.on('message', listener);
    redis.publish(HEALTH_PROBE_CHANNEL, nonce).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error('publish failed'));
    });
  });
}

export async function checkHealth(inputs: HealthInputs): Promise<Health> {
  const now = inputs.now ?? Date.now;
  const timeoutMs = inputs.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const nonce = (inputs.nonce ?? defaultNonce)();

  // In parallel: a health endpoint that runs three checks in series takes as
  // long as their sum, and a probe that times out would then delay the answer
  // past the point where anything is still waiting for it.
  const checks = await Promise.all([
    timed('postgres', inputs.query, now),
    timed('redis', () => inputs.redis.ping(), now),
    timed(
      'redis-pubsub',
      () => probePubSub(inputs.redis, inputs.probeSubscriber, nonce, timeoutMs),
      now,
    ),
  ]);

  const counts = inputs.counts();
  return {
    // 'degraded', not 'fail': the replica is still serving the sockets it has,
    // and reporting total failure would be a lie that reads worse than the
    // truth. The per-check status is where the detail is.
    status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
    service: 'sync',
    version: inputs.version,
    uptimeSeconds: Math.max(0, Math.floor((now() - inputs.startedAt) / 1000)),
    checks,
    connections: counts.connections,
    documents: counts.documents,
  };
}

function defaultNonce(): string {
  // Unique per probe so two replicas probing at once cannot satisfy each
  // other's wait. Both subscribe to the same channel, and a shared constant
  // would let replica A's publish resolve replica B's probe -- a green health
  // check on a replica whose own publisher is dead.
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

/** HTTP status for a health body. 503 when anything failed, so a probe can act on it. */
export function statusCodeFor(health: Health): number {
  return health.status === 'ok' ? 200 : 503;
}
