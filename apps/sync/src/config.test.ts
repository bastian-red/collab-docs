import { describe, expect, it } from 'vitest';

import { ConfigError, assertCoherent, resolvePort, type SyncConfig } from './config.js';

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

const BASE: SyncConfig = {
  port: 4100,
  databaseUrl: 'postgresql://collab:collab@localhost:5440/collab',
  redisUrl: 'redis://localhost:6386',
  authSecret: 'x'.repeat(32),
  appVersion: '0.1.0',
  compaction: { afterUpdates: 200, afterSeconds: 120 },
  versions: { intervalSeconds: 300, maxPerDocument: 50 },
  storeDebounceMs: 2000,
  storeMaxDebounceMs: 10_000,
  maxPayloadBytes: 1_048_576,
  messageRateLimit: 1200,
  documentMaxBytes: 5_242_880,
  awarenessTimeoutMs: 30_000,
};

describe('resolvePort', () => {
  it('prefers PORT over SYNC_PORT', () => {
    // The whole reason replica 2 exists without a second Dockerfile. Reverse
    // this and the compose override does nothing, both "replicas" land on 4100,
    // and the cross-replica test passes with one process.
    expect(resolvePort(env({ PORT: '4101', SYNC_PORT: '4100' }))).toBe(4101);
  });

  it('falls back to SYNC_PORT when PORT is absent', () => {
    expect(resolvePort(env({ SYNC_PORT: '4100' }))).toBe(4100);
  });

  it('treats an empty PORT as absent', () => {
    // `.env.example` ships `PORT=` with no value on purpose, so a reader can see
    // the knob. An empty string is not an override.
    expect(resolvePort(env({ PORT: '', SYNC_PORT: '4100' }))).toBe(4100);
    expect(resolvePort(env({ PORT: '   ', SYNC_PORT: '4100' }))).toBe(4100);
  });

  it('refuses a value that is not a TCP port', () => {
    for (const bad of ['0', '65536', '-1', 'four thousand', '4100.5']) {
      expect(() => resolvePort(env({ PORT: bad })), bad).toThrow(ConfigError);
    }
  });

  it('refuses to guess when neither name is set', () => {
    expect(() => resolvePort(env({}))).toThrow(/Neither PORT nor SYNC_PORT/u);
  });
});

describe('assertCoherent', () => {
  it('accepts the documented defaults', () => {
    expect(() => assertCoherent(BASE)).not.toThrow();
  });

  it('refuses a maximum debounce below the debounce', () => {
    // Starts cleanly, then defers the checkpoint forever under continuous
    // typing, and nothing in the logs says the two numbers disagree.
    expect(() => assertCoherent({ ...BASE, storeMaxDebounceMs: 1000 })).toThrow(
      /ceiling on the debounce/u,
    );
  });

  it('accepts a maximum debounce exactly equal to the debounce', () => {
    expect(() =>
      assertCoherent({ ...BASE, storeMaxDebounceMs: BASE.storeDebounceMs }),
    ).not.toThrow();
  });

  it('refuses a frame ceiling at or above the document ceiling', () => {
    // The frame is checked first, always, so an equal or larger frame limit
    // makes DOCUMENT_MAX_BYTES unreachable and the document ceiling a comment.
    expect(() => assertCoherent({ ...BASE, maxPayloadBytes: BASE.documentMaxBytes })).toThrow(
      /ceiling unreachable/u,
    );
    expect(() => assertCoherent({ ...BASE, maxPayloadBytes: BASE.documentMaxBytes + 1 })).toThrow();
  });
});
