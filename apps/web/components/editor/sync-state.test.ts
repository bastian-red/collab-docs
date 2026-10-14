import { describe, expect, it } from 'vitest';

import {
  SYNC_PRESENTATION,
  refusalFromClose,
  shouldAnnounce,
  syncState,
  type ProviderSignals,
} from './sync-state';

const healthy: ProviderSignals = {
  socket: 'connected',
  synced: true,
  unsyncedChanges: 0,
  refusal: null,
};

describe('syncState precedence', () => {
  it('is synced only when connected, handshaken and fully acknowledged', () => {
    expect(syncState(healthy)).toBe('synced');
  });

  it('is saving while an update is unacknowledged or the handshake is unfinished', () => {
    expect(syncState({ ...healthy, unsyncedChanges: 3 })).toBe('saving');
    expect(syncState({ ...healthy, synced: false })).toBe('saving');
  });

  it('says offline rather than saving when the socket is down', () => {
    // "Saving" over a dead socket is the lie this precedence exists to prevent.
    expect(syncState({ ...healthy, socket: 'disconnected', unsyncedChanges: 5 })).toBe('offline');
    expect(syncState({ ...healthy, socket: 'connecting' })).toBe('offline');
  });

  it('says refused over everything, because reconnecting will not fix it', () => {
    expect(syncState({ ...healthy, refusal: 'no-access' })).toBe('refused');
    expect(syncState({ ...healthy, socket: 'disconnected', refusal: 'x' })).toBe('refused');
  });
});

describe('every state is a glyph and a word', () => {
  it('has four distinct glyphs and four distinct words', () => {
    const entries = Object.values(SYNC_PRESENTATION);
    expect(new Set(entries.map((entry) => entry.glyph)).size).toBe(4);
    expect(new Set(entries.map((entry) => entry.word)).size).toBe(4);
  });

  it('never names a conflict, because a CRDT has none to report', () => {
    expect(
      Object.values(SYNC_PRESENTATION)
        .map((entry) => entry.word)
        .join(' '),
    ).not.toMatch(/conflict/iu);
  });
});

describe('announcements', () => {
  it('announces only the transitions that change what the reader should do', () => {
    expect(shouldAnnounce('synced', 'offline')).toBe(true);
    expect(shouldAnnounce('saving', 'refused')).toBe(true);
    expect(shouldAnnounce('synced', 'saving')).toBe(false);
    expect(shouldAnnounce('saving', 'synced')).toBe(false);
    expect(shouldAnnounce('offline', 'offline')).toBe(false);
  });
});

describe('refusalFromClose', () => {
  it('treats the application range as a refusal', () => {
    expect(refusalFromClose(4403, 'Forbidden')).toBe('Forbidden');
    expect(refusalFromClose(4000, '')).toBe('The server closed this document.');
  });

  it('treats transport closes as merely offline', () => {
    expect(refusalFromClose(1000, 'bye')).toBeNull();
    expect(refusalFromClose(1006, '')).toBeNull();
    expect(refusalFromClose(5000, 'x')).toBeNull();
  });
});
