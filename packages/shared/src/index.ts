/**
 * The browser-safe entry point of @docs/shared.
 *
 * Everything re-exported here must be importable from a client component. The
 * things that must not -- `jsonwebtoken`, scrypt, `AUTH_SECRET` -- live behind
 * the `@docs/shared/server` subpath, which is the boundary that keeps them out
 * of the client bundle. `packages/config/tsconfig.node.json` sets
 * `moduleResolution: Node16` so that subpath resolves at all.
 */

export * from './contracts';
export * from './errors';
export * from './roles';
export * from './paths';
export * from './rooms';
export * from './cursor-colour';
export * from './document-bytes';
export * from './initials';
export * from './time/relative';
