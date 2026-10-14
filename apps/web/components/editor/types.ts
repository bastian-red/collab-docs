/**
 * The contract between the server-rendered workspace and the client-only editor
 * island. Kept in its own module with no Yjs or TipTap import, so the workspace
 * (which renders on the server) can name these types without pulling the CRDT into
 * the server bundle (docs/CODESTYLE.md 17).
 */
import type { ProviderSignals } from './sync-state';

export interface Participant {
  readonly userId: string;
  readonly name: string;
  /** How many tabs or windows this person has open on the document. */
  readonly connections: number;
}

export interface EditorHandle {
  /** Replace the live document with a stored version's content, as one ordinary edit (SPECS 5.2). */
  restoreFrom(stateBase64: string): void;
}

export interface EditorSurfaceProps {
  readonly documentId: string;
  readonly title: string;
  readonly shareToken: string | null;
  readonly syncUrl: string;
  readonly user: { readonly id: string; readonly name: string };
  readonly editable: boolean;
  readonly onSignals: (signals: ProviderSignals) => void;
  readonly onParticipants: (participants: Participant[]) => void;
  readonly onReady: (handle: EditorHandle | null) => void;
  /** Where the toolbar is portalled: above the page, in the workspace's DOM. */
  readonly toolbarSlot: HTMLElement | null;
}
