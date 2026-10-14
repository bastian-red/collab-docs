import { HEALTH_PROBE_CHANNEL, healthSchema } from '@docs/shared';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { checkHealth, probePubSub, statusCodeFor } from './health.js';

/**
 * A Redis pair that behaves like the real one for the two operations the probe
 * uses, and can be made to misbehave in the specific ways that matter: a
 * publisher that throws, and a subscriber that has gone deaf.
 */
class FakeRedis extends EventEmitter {
  delivered = 0;
  deaf = false;
  publishError: Error | null = null;
  pingError: Error | null = null;
  /** The subscriber this publisher delivers to. Set for the pub half only. */
  peer: FakeRedis | null = null;

  async ping(): Promise<string> {
    if (this.pingError !== null) throw this.pingError;
    return 'PONG';
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.publishError !== null) throw this.publishError;
    if (this.peer !== null && !this.peer.deaf) {
      this.delivered += 1;
      // Asynchronously, like the real thing: a synchronous delivery would let a
      // broken implementation pass by resolving before it had subscribed.
      setImmediate(() => this.peer?.emit('message', channel, message));
    }
    return 1;
  }
}

function pair(): { pub: FakeRedis; sub: FakeRedis } {
  const pub = new FakeRedis();
  const sub = new FakeRedis();
  pub.peer = sub;
  return { pub, sub };
}

type RedisLike = Parameters<typeof probePubSub>[0];

describe('probePubSub', () => {
  it('resolves when the nonce comes back', async () => {
    const { pub, sub } = pair();
    await expect(
      probePubSub(pub as unknown as RedisLike, sub as unknown as RedisLike, 'n1', 200),
    ).resolves.toBeUndefined();
  });

  it('rejects when the subscriber has gone deaf', async () => {
    // The failure no ordinary probe catches: sockets fine, PING fine, nothing
    // relayed. From a user's seat the other person just stopped typing.
    const { pub, sub } = pair();
    sub.deaf = true;
    await expect(
      probePubSub(pub as unknown as RedisLike, sub as unknown as RedisLike, 'n1', 50),
    ).rejects.toThrow(/not relaying/u);
  });

  it('ignores a message that is not this probe', async () => {
    // Two replicas share the channel, so this replica sees the other one's
    // nonces. Resolving on any message would make a replica whose own publisher
    // is dead report green as long as its neighbour is alive.
    const { pub, sub } = pair();
    pub.peer = null;
    setTimeout(() => sub.emit('message', HEALTH_PROBE_CHANNEL, 'somebody-elses-nonce'), 5);
    setTimeout(() => sub.emit('message', 'another-channel', 'n1'), 10);
    await expect(
      probePubSub(pub as unknown as RedisLike, sub as unknown as RedisLike, 'n1', 60),
    ).rejects.toThrow(/not relaying/u);
  });

  it('removes its listener on every path, including the timeout', async () => {
    // Without this a replica whose Redis is slow gains a listener per probe,
    // warns at eleven, and then leaks quietly for as long as it runs.
    const { pub, sub } = pair();
    await probePubSub(pub as unknown as RedisLike, sub as unknown as RedisLike, 'ok', 200);
    expect(sub.listenerCount('message')).toBe(0);

    sub.deaf = true;
    await probePubSub(pub as unknown as RedisLike, sub as unknown as RedisLike, 'late', 30).catch(
      () => undefined,
    );
    expect(sub.listenerCount('message')).toBe(0);

    pub.publishError = new Error('connection lost');
    await probePubSub(pub as unknown as RedisLike, sub as unknown as RedisLike, 'boom', 200).catch(
      () => undefined,
    );
    expect(sub.listenerCount('message')).toBe(0);
  });

  it('rejects immediately when the publish itself fails', async () => {
    const { pub, sub } = pair();
    pub.publishError = new Error('connection lost');
    await expect(
      probePubSub(pub as unknown as RedisLike, sub as unknown as RedisLike, 'n1', 5000),
    ).rejects.toThrow(/connection lost/u);
  });
});

describe('checkHealth', () => {
  function inputs(overrides: Partial<Parameters<typeof checkHealth>[0]> = {}) {
    const { pub, sub } = pair();
    let clock = 1_000_000;
    return {
      version: '0.1.0',
      startedAt: 1_000_000 - 90_000,
      query: async () => [{ '?column?': 1 }],
      redis: pub as unknown as RedisLike,
      probeSubscriber: sub as unknown as RedisLike,
      counts: () => ({ connections: 3, documents: 2 }),
      now: () => (clock += 1),
      probeTimeoutMs: 60,
      nonce: () => 'fixed-nonce',
      ...overrides,
    } as Parameters<typeof checkHealth>[0];
  }

  it('reports ok with all three checks green, and parses as the shared contract', async () => {
    const health = await checkHealth(inputs());
    const parsed = healthSchema.parse(health);
    expect(parsed.status).toBe('ok');
    expect(parsed.service).toBe('sync');
    expect(parsed.checks.map((check) => check.name)).toEqual(['postgres', 'redis', 'redis-pubsub']);
    expect(parsed.connections).toBe(3);
    expect(parsed.documents).toBe(2);
    expect(statusCodeFor(parsed)).toBe(200);
  });

  it('is degraded, not ok, when Postgres is down', async () => {
    const health = await checkHealth(
      inputs({
        query: async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:5440');
        },
      }),
    );
    expect(health.status).toBe('degraded');
    expect(health.checks.find((check) => check.name === 'postgres')?.status).toBe('fail');
    expect(statusCodeFor(health)).toBe(503);
  });

  it('is degraded when the relay is dead even though Postgres and PING are fine', async () => {
    // The whole reason the third check exists. Without it this replica reports
    // 200 while silently relaying nothing.
    const { pub, sub } = pair();
    sub.deaf = true;
    const health = await checkHealth(
      inputs({ redis: pub as unknown as RedisLike, probeSubscriber: sub as unknown as RedisLike }),
    );
    expect(health.checks.find((check) => check.name === 'postgres')?.status).toBe('ok');
    expect(health.checks.find((check) => check.name === 'redis')?.status).toBe('ok');
    expect(health.checks.find((check) => check.name === 'redis-pubsub')?.status).toBe('fail');
    expect(health.status).toBe('degraded');
  });

  it('reports a message and never a stack', async () => {
    // The body is public. A stack carries absolute paths and library versions.
    const health = await checkHealth(
      inputs({
        query: async () => {
          throw new Error('relation "documents" does not exist');
        },
      }),
    );
    const detail = health.checks.find((check) => check.name === 'postgres')?.detail ?? '';
    expect(detail).toBe('relation "documents" does not exist');
    expect(detail).not.toMatch(/\bat \//u);
  });

  it('runs the three checks in parallel, not in series', async () => {
    // In series, a probe that times out delays the whole answer past the point
    // where anything is still waiting for it.
    const { pub, sub } = pair();
    sub.deaf = true;
    const started = Date.now();
    await checkHealth(
      inputs({
        redis: pub as unknown as RedisLike,
        probeSubscriber: sub as unknown as RedisLike,
        query: async () => new Promise((resolve) => setTimeout(resolve, 60)),
        probeTimeoutMs: 60,
        now: Date.now,
      }),
    );
    // Two 60ms waits in series would be 120. Generous headroom, because this is
    // a timing assertion and CI machines are not quiet.
    expect(Date.now() - started).toBeLessThan(115);
  });

  it('reports uptime in whole seconds and never negative', async () => {
    const health = await checkHealth(inputs({ startedAt: 2_000_000, now: () => 1_000_000 }));
    expect(health.uptimeSeconds).toBe(0);
  });
});
