import { defineConfig } from 'vitest/config';

/**
 * The integration lane: real Postgres, real Redis, two real sync replicas.
 *
 * A separate config, and a separate directory from `src/`, so `pnpm test` --
 * the gate lane, which runs on every commit and must stay under two seconds and
 * never be flaky -- cannot accidentally pick these up. They are started by
 * `./scripts/integration.sh`, which is the only thing that knows how to bring
 * the replicas up.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/**/*.test.ts'],
    // A websocket handshake, a Redis relay and a Postgres round trip. The gate
    // lane's budget does not apply and pretending it does produces flakes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One file at a time: the replicas are shared process-wide state, and two
    // files racing on the same seeded document would make every failure a
    // question about ordering.
    fileParallelism: false,
  },
});
