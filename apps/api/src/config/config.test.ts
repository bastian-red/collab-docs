import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';
import { BootError, SHARE_LINK_TTL_MAX_HOURS, assertConsistent } from './boot';

/**
 * A complete environment, so every test below changes exactly one thing and the
 * assertion is about that thing.
 */
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_VERSION: '0.1.0',
    API_PORT: '4000',
    DATABASE_URL: 'postgresql://collab:collab@localhost:5440/collab',
    REDIS_URL: 'redis://localhost:6386',
    AUTH_SECRET: 'x'.repeat(32),
    APP_BASE_URL: 'http://localhost:3000',
    DOCUMENT_LIST_PAGE_SIZE: '25',
    SHARE_LINK_TTL_HOURS: '168',
    RATE_LIMIT_GLOBAL: '240',
    RATE_LIMIT_AUTH: '5',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('reads the documented environment', () => {
    const config = loadConfig(env());
    expect(config.port).toBe(4000);
    expect(config.documentListPageSize).toBe(25);
    expect(config.shareLinkTtlHours).toBe(168);
  });

  // The precedence that lets a container runtime move the process without a
  // second image, and the same one apps/sync/src/config.ts uses. Reversing it
  // would make the compose override silently do nothing.
  it('prefers PORT over API_PORT', () => {
    expect(loadConfig(env({ PORT: '4200' })).port).toBe(4200);
  });

  // `.env.example` ships PORT empty on purpose, so both services can run on one
  // host. An empty string must fall through, not fail the port regex.
  it('falls through an empty PORT to API_PORT', () => {
    expect(loadConfig(env({ PORT: '' })).port).toBe(4000);
    expect(loadConfig(env({ PORT: '   ' })).port).toBe(4000);
  });

  it('defaults NODE_ENV and APP_VERSION rather than refusing to start', () => {
    const config = loadConfig(env({ NODE_ENV: undefined, APP_VERSION: undefined }));
    expect(config.nodeEnv).toBe('development');
    expect(config.appVersion).toBe('0.0.0');
  });

  /**
   * The whole point of parsing at the edge: a fresh clone learns every missing
   * name at once instead of starting the process five times.
   */
  it('names every missing variable in one message', () => {
    const broken = env({ DATABASE_URL: undefined, REDIS_URL: undefined, AUTH_SECRET: undefined });
    expect(() => loadConfig(broken)).toThrow(ConfigError);
    try {
      loadConfig(broken);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('AUTH_SECRET');
    }
  });

  it('refuses a short AUTH_SECRET, and says how short', () => {
    expect(() => loadConfig(env({ AUTH_SECRET: 'short' }))).toThrow(/at least 16 characters/u);
  });

  /**
   * `z.string().url()` on its own is not enough, and this is the case that
   * proves it. Measured before it was written:
   * `z.string().url().safeParse('localhost:3000').success` is `true`, because
   * `new URL('localhost:3000')` parses with protocol `localhost:` and path
   * `3000`. Every share link would then be built on that base.
   */
  it('refuses an APP_BASE_URL with no http(s) scheme', () => {
    expect(() => loadConfig(env({ APP_BASE_URL: 'localhost:3000' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ APP_BASE_URL: 'not a url' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ APP_BASE_URL: 'ftp://files.example.com' }))).toThrow(ConfigError);
    expect(loadConfig(env({ APP_BASE_URL: 'https://docs.example.com' })).appBaseUrl).toBe(
      'https://docs.example.com',
    );
  });

  it('refuses a non-numeric page size', () => {
    expect(() => loadConfig(env({ DOCUMENT_LIST_PAGE_SIZE: '25 documents' }))).toThrow(ConfigError);
  });
});

describe('assertConsistent', () => {
  it('accepts the documented defaults', () => {
    expect(() => {
      assertConsistent(loadConfig(env()));
    }).not.toThrow();
  });

  it('refuses an auth budget at or above the global one', () => {
    expect(() => {
      assertConsistent(loadConfig(env({ RATE_LIMIT_AUTH: '240' })));
    }).toThrow(BootError);
    expect(() => {
      assertConsistent(loadConfig(env({ RATE_LIMIT_AUTH: '600' })));
    }).toThrow(/credential-stuffing/u);
  });

  /**
   * The failure this one prevents is the confusing kind: the default TTL is
   * above what `createShareLinkSchema` accepts, so every link created WITHOUT an
   * expiry is refused by the same schema that validated the request. A 400 on
   * the happy path, caused by a number in .env.
   */
  it('refuses a default TTL the share contract would reject', () => {
    const tooLong = String(SHARE_LINK_TTL_MAX_HOURS + 1);
    expect(() => {
      assertConsistent(loadConfig(env({ SHARE_LINK_TTL_HOURS: tooLong })));
    }).toThrow(BootError);
    expect(() => {
      assertConsistent(loadConfig(env({ SHARE_LINK_TTL_HOURS: String(SHARE_LINK_TTL_MAX_HOURS) })));
    }).not.toThrow();
  });

  it('refuses a page size that turns the sidebar into a full table scan', () => {
    expect(() => {
      assertConsistent(loadConfig(env({ DOCUMENT_LIST_PAGE_SIZE: '5000' })));
    }).toThrow(BootError);
  });
});
