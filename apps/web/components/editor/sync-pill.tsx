'use client';

import { useEffect, useRef, useState } from 'react';

import { SYNC_PRESENTATION, shouldAnnounce, type SyncState } from './sync-state';

/**
 * The connection state as a glyph AND a word (docs/DESIGN.md 5.1).
 *
 * The visible pill is not a live region: it flips between Synced and Saving
 * several times a second while somebody types, and a screen reader announcing
 * each flip would talk over the typing. A separate polite region carries only the
 * transitions `shouldAnnounce` admits -- into Offline and Not saving -- which are
 * the two that change what the reader should do.
 */
export function SyncPill({
  state,
  detail,
}: {
  readonly state: SyncState;
  readonly detail: string | null;
}) {
  const previous = useRef<SyncState | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (shouldAnnounce(previous.current, state)) {
      setAnnouncement(
        state === 'offline'
          ? 'You are offline. Your edits are kept on this device and will merge when you reconnect.'
          : `Your changes are not being saved. ${detail ?? ''}`.trim(),
      );
    }
    previous.current = state;
  }, [state, detail]);

  const { glyph, word } = SYNC_PRESENTATION[state];
  return (
    <>
      <span className="sync-pill" data-state={state} title={detail ?? undefined}>
        <span className="sync-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="sync-word">{word}</span>
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
