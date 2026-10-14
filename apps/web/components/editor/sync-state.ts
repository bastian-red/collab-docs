/**
 * The connection pill's state, as a pure function of what the provider reports.
 *
 * Four states, each a glyph AND a word (docs/DESIGN.md 5.1), because the four
 * colours collapse to one grey for a reader with a colour-vision deficiency:
 *
 *   synced    the server has every local update
 *   saving    local updates are sent and not yet acknowledged
 *   offline   the socket is down; edits sit in IndexedDB and will merge
 *   refused   the server closed on us on purpose: lost access, deleted, too large
 *
 * Kept free of React and of the provider so the precedence is a test rather than
 * a reading of an effect. The precedence is the whole content: `refused` beats
 * everything because reconnecting will not fix it and the writer must know their
 * words are not being kept; `offline` beats `saving` because "Saving" over a dead
 * socket is a lie that lasts until the laptop wakes up.
 */
export type SyncState = 'synced' | 'saving' | 'offline' | 'refused';

export interface ProviderSignals {
  /** The websocket's own status. */
  readonly socket: 'connecting' | 'connected' | 'disconnected';
  /** Whether the initial sync handshake has completed on this connection. */
  readonly synced: boolean;
  /** Local updates sent and not yet acknowledged with a SyncStatus. */
  readonly unsyncedChanges: number;
  /** Set once the server refuses us; cleared only by a fresh page. */
  readonly refusal: string | null;
}

export function syncState(signals: ProviderSignals): SyncState {
  if (signals.refusal !== null) return 'refused';
  if (signals.socket !== 'connected') return 'offline';
  if (!signals.synced || signals.unsyncedChanges > 0) return 'saving';
  return 'synced';
}

export const SYNC_PRESENTATION: Readonly<
  Record<SyncState, { readonly glyph: string; readonly word: string }>
> = Object.freeze({
  synced: { glyph: '●', word: 'Synced' },
  saving: { glyph: '◐', word: 'Saving' },
  offline: { glyph: '▲', word: 'Offline' },
  refused: { glyph: '⚠', word: 'Not saving' },
});

/**
 * Whether a transition should be announced to a screen reader.
 *
 * Only into `offline` and `refused`. Announcing every Synced/Saving flip would
 * talk over a screen-reader user's own typing several times a second; those two
 * are the states that change what the reader should do.
 */
export function shouldAnnounce(previous: SyncState | null, next: SyncState): boolean {
  if (previous === next) return false;
  return next === 'offline' || next === 'refused';
}

/**
 * What a websocket close means.
 *
 * Application close codes are 4000-4999 (RFC 6455 7.4.2); Hocuspocus uses them
 * for refusals it raises on purpose (`Forbidden`, `ResetConnection`, a thrown hook
 * error). 1000-1015 are the transport: a laptop lid, a proxy timeout, a server
 * restart. Only the first kind is a refusal; the second kind is just offline, and
 * the provider's own retry is the correct response to it.
 */
export function refusalFromClose(code: number, reason: string): string | null {
  if (code < 4000 || code > 4999) return null;
  return reason.length > 0 ? reason : 'The server closed this document.';
}
