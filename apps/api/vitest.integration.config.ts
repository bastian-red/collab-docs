import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * The API's integration lane: the real Nest graph, the real Postgres, the real
 * Redis.
 *
 * A separate config and a separate directory from `src/`, so `pnpm test` -- the
 * gate lane, which runs on every commit and must stay fast and never flaky --
 * cannot pick these up. `./scripts/integration.sh` is the only thing that knows
 * how to bring the datastores up and seed them.
 *
 * The application is booted IN PROCESS rather than as a child, because the thing
 * under test is the module graph: the global guard being default-closed, the
 * error filter's mapping, an ownership transfer that is really one transaction.
 * A child process would test the same code through one more layer of guessing
 * about why it failed.
 *
 * ---------------------------------------------------------------------------
 * Why SWC and not vitest's default esbuild
 *
 * **esbuild does not emit `design:paramtypes`.** Nest resolves a constructor
 * dependency from the metadata TypeScript writes under `emitDecoratorMetadata`,
 * and esbuild has no support for it at all -- so under the default transform
 * every injected class arrives as `undefined` and the first guard that touches
 * one throws `Cannot read properties of undefined`. Measured, not assumed: that
 * is the exact error this lane produced before this plugin was added, from
 * `SessionGuard.canActivate` reading `this.reflector`.
 *
 * That is not a thing to work around in the application by writing `@Inject()`
 * on every parameter. `nest build` compiles with `tsc`, which emits the metadata
 * correctly, so a lane that needed the code changed to run would be testing a
 * different program from the one that ships -- which is the rule
 * docs/SPECS.md 9.3 states about lanes that supply their own environment,
 * applied to the compiler.
 *
 * `unplugin-swc` is the tried-and-true answer here: SWC implements
 * `emitDecoratorMetadata`, it is what Nest's own vitest guidance uses, and it
 * reads the same `tsconfig.json` the build does.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One file at a time. These tests write to a shared database, and two files
    // racing on the same seeded rows would make every failure a question about
    // ordering rather than about behaviour.
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
