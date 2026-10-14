import { defineConfig } from 'vitest/config';

// Gate lane: fast, deterministic, no network and no database. Everything here
// runs against plain objects and fakes; the endpoints themselves are exercised
// by the E2E lane, which has a Postgres.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
