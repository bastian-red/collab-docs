import { describe, expect, it } from 'vitest';

import { HEALTH_PROBE_CHANNEL, documentRoom, offlineStoreName } from './rooms';

describe('room names', () => {
  it('names a document room by the bare id, which is what apps/sync parses', () => {
    // The cross-process half of this property lives in apps/sync/src/auth.test.ts,
    // which feeds documentRoom() through the server's own parser.
    expect(documentRoom('clx8k2p0000008l3f4h2g9d7')).toBe('clx8k2p0000008l3f4h2g9d7');
  });

  it('namespaces the offline store so it cannot collide with another app on the origin', () => {
    expect(offlineStoreName('abc')).toBe('collab-docs:abc');
    expect(offlineStoreName('abc')).not.toBe(documentRoom('abc'));
  });

  it('keeps the health probe on its own channel', () => {
    expect(HEALTH_PROBE_CHANNEL).toBe('collab:health:probe');
  });
});
