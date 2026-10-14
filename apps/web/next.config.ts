import type { NextConfig } from 'next';

/**
 * `output: 'standalone'` because Docker is the only target: `infra/Dockerfile.web`
 * copies `.next/standalone` and runs `server.js`, which needs the traced
 * dependency set in one directory.
 *
 * `turbopack.root` is the monorepo root. Without it Next 16 infers the root from
 * the nearest lockfile it can find walking up, which on a developer machine can
 * be a lockfile in a PARENT directory that has nothing to do with this repo, and
 * the build then resolves `node_modules` from the wrong tree with a warning that
 * scrolls away.
 *
 * `@docs/shared` ships CommonJS out of `dist/`; Turbopack consumes it as is, so it
 * is not in `transpilePackages`. Only its browser entry point is reachable from a
 * client component: `@docs/shared/server` is imported in files that start with
 * `import 'server-only'`, and the build fails if a client component reaches one.
 */
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: root,
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root },
};

export default nextConfig;
