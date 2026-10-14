'use client';

/**
 * The editor island: the only module in this app that holds a `Y.Doc`.
 *
 * Loaded with `next/dynamic({ ssr: false })` from the workspace, and TipTap is
 * created with `immediatelyRender: false`, which the TipTap skill states is
 * required under SSR. Nothing here runs on the server (docs/SPECS.md 12.4).
 *
 * Lifecycle, and why it is in an effect rather than a `useMemo`: React Strict Mode
 * mounts, unmounts and remounts every component in development. A provider created
 * during render would be created twice and destroyed once, leaving a second
 * socket open and two awareness clients for one tab -- which shows up as the
 * writer seeing their own caret. Created in an effect, the cleanup destroys exactly
 * what the effect made.
 *
 * Order inside the effect matters: IndexedDB is attached BEFORE the provider
 * connects, so edits made offline before the first sync are in the document the
 * provider then reconciles, instead of arriving after it as a second history.
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import { cursorColour, documentRoom, offlineStoreName } from '@docs/shared';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import { participantsFrom } from './participants';
import { refusalFromClose, type ProviderSignals } from './sync-state';
import { Toolbar } from './toolbar';
import type { EditorSurfaceProps } from './types';

/** The field `apps/sync` and the seed write: `DOCUMENT_FRAGMENT` in `@docs/doc-store`. */
const FIELD = 'default';

interface Session {
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
}

/**
 * The socket token, minted per connection attempt by our own route.
 *
 * The callback form, never a value: a value goes stale on the first reconnect
 * past its 120-second life, and reconnecting after a laptop sleeps is the normal
 * case, not the edge case (docs/SPECS.md 4.1).
 */
async function fetchToken(): Promise<string> {
  const response = await fetch('/api/sync-token', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`sync token refused: ${String(response.status)}`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string') throw new Error('sync token missing from response');
  return body.token;
}

function socketUrl(base: string, shareToken: string | null): string {
  if (shareToken === null) return base;
  const url = new URL(base);
  // The share token travels on the socket URL, not in the JWT: revoking a link
  // must take effect on the next handshake without reissuing anyone's session.
  url.searchParams.set('share', shareToken);
  return url.toString();
}

/**
 * The caret: a coloured bar with the writer's NAME always rendered beside it.
 *
 * Not on hover and not in a tooltip (docs/DESIGN.md 5.3). Eight hues cannot stay
 * apart for a deuteranopic reader, and a hover label is invisible to a keyboard
 * user and in a screenshot. The colours are set as custom properties so the
 * stylesheet picks the light or dark value per scheme; the name is a text node,
 * so it is in the accessibility tree and an E2E test can find it by its text.
 */
function renderCaret(user: Record<string, unknown>): HTMLElement {
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.style.setProperty('--caret-light', String(user.color ?? ''));
  caret.style.setProperty('--caret-dark', String(user.colorDark ?? ''));
  caret.style.setProperty('--caret-ink-light', String(user.ink ?? ''));
  caret.style.setProperty('--caret-ink-dark', String(user.inkDark ?? ''));

  const label = document.createElement('span');
  label.className = 'caret-label';
  label.textContent = typeof user.name === 'string' ? user.name : 'Someone';
  caret.append(label);
  return caret;
}

export default function EditorSurface({
  documentId,
  title,
  shareToken,
  syncUrl,
  user,
  editable,
  onSignals,
  onParticipants,
  onReady,
  toolbarSlot,
}: EditorSurfaceProps) {
  const [session, setSession] = useState<Session | null>(null);
  // Callbacks in a ref so the effect below depends only on what identifies the
  // connection. A parent re-render handing new function identities must not tear
  // the socket down and rebuild it.
  const callbacks = useRef({ onSignals, onParticipants });
  callbacks.current = { onSignals, onParticipants };

  useEffect(() => {
    const doc = new Y.Doc();
    const offline = new IndexeddbPersistence(offlineStoreName(documentId), doc);

    let signals: ProviderSignals = {
      socket: 'connecting',
      synced: false,
      unsyncedChanges: 0,
      refusal: null,
    };
    const emit = (next: Partial<ProviderSignals>) => {
      signals = { ...signals, ...next };
      callbacks.current.onSignals(signals);
    };

    const provider = new HocuspocusProvider({
      url: socketUrl(syncUrl, shareToken),
      name: documentRoom(documentId),
      document: doc,
      token: fetchToken,
      onStatus: ({ status }) =>
        emit({ socket: status, ...(status === 'connected' ? {} : { synced: false }) }),
      onSynced: ({ state }) => emit({ synced: state }),
      onUnsyncedChanges: ({ number }) => emit({ unsyncedChanges: number }),
      onAuthenticationFailed: ({ reason }) => {
        emit({ refusal: reason || 'Access to this document was refused.' });
        // Retrying a refused handshake only repeats the refusal and fills the
        // server log; the reader needs a new link or a reload, not a loop.
        provider.disconnect();
      },
      onClose: ({ event }) => {
        const refusal = refusalFromClose(event.code, event.reason);
        if (refusal !== null) emit({ refusal });
      },
    });

    const publishParticipants = () =>
      callbacks.current.onParticipants(
        participantsFrom(provider.awareness?.getStates().values() ?? [], user.id),
      );
    provider.awareness?.on('change', publishParticipants);

    setSession({ doc, provider });
    return () => {
      provider.awareness?.off('change', publishParticipants);
      provider.destroy();
      void offline.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [documentId, shareToken, syncUrl, user.id]);

  const colour = cursorColour(user.id);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions:
        session === null
          ? [StarterKit]
          : [
              // Yjs owns history: StarterKit's undo stack would undo other people's
              // typing, because to ProseMirror every remote edit is a transaction.
              StarterKit.configure({ undoRedo: false }),
              Collaboration.configure({ document: session.doc, field: FIELD }),
              CollaborationCaret.configure({
                provider: session.provider,
                user: {
                  id: user.id,
                  name: user.name,
                  color: colour.light,
                  colorDark: colour.dark,
                  ink: colour.lightInk,
                  inkDark: colour.darkInk,
                },
                render: renderCaret,
                // A remote selection is the writer's hue at 25% over the page. The
                // text on it stays above 7:1 in both schemes for all eight hues
                // (docs/DESIGN.md 2.4); the colour is set per scheme in CSS.
                selectionRender: (attributes: Record<string, unknown>) => ({
                  nodeName: 'span',
                  class: 'remote-selection',
                  style: `--sel-light: ${String(attributes.color ?? '')}; --sel-dark: ${String(attributes.colorDark ?? '')}`,
                }),
              }),
              Placeholder.configure({ placeholder: 'Start writing' }),
            ],
      editorProps: {
        attributes: {
          class: 'prose',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': title,
          'aria-readonly': editable ? 'false' : 'true',
        },
      },
    },
    [session],
  );

  useEffect(() => {
    if (editor === null || session === null) {
      onReady(null);
      return;
    }
    onReady({
      restoreFrom(stateBase64: string) {
        // SPECS 5.2: materialise the version in a DETACHED doc, read it as
        // ProseMirror JSON, and set it on the live editor as one ordinary edit.
        // Every other client converges on it like on any keystroke, and a
        // read-only connection's attempt is dropped by the server like any other.
        const detached = new Y.Doc();
        const bytes = Uint8Array.from(atob(stateBase64), (char) => char.charCodeAt(0));
        Y.applyUpdate(detached, bytes);
        const json = yXmlFragmentToProsemirrorJSON(detached.getXmlFragment(FIELD));
        detached.destroy();
        editor.commands.setContent(json);
      },
    });
    return () => onReady(null);
  }, [editor, session, onReady]);

  return (
    <>
      {/* The toolbar sits above the page, outside the island's own DOM, so it is
          portalled into a slot the workspace renders there. */}
      {editable && editor !== null && toolbarSlot !== null
        ? createPortal(<Toolbar editor={editor} />, toolbarSlot)
        : null}
      <EditorContent editor={editor} className="editor-host" />
    </>
  );
}
