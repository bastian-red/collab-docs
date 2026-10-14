import type { Metadata, Viewport } from 'next';
import { Karla, Red_Hat_Mono, Spectral } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * The document, the three typefaces, and the skip link.
 *
 * **`auth()` is not called here, and must not be.** A root layout that awaits the
 * session opts every route into dynamic rendering, including `/sign-in`, which has
 * no session to read. Pages read it themselves (`lib/session.ts`).
 *
 * The faces (docs/SPECS.md 8.1, docs/DESIGN.md 2.5):
 *
 * - **Spectral** is the page. Drawn by Production Type for reading documents on
 *   screen, and this is the one project where the body face is the product. It
 *   appears on the page and in document titles and nowhere else, so a reader can
 *   tell somebody's writing from the application by typography alone.
 * - **Karla** is the chrome: toolbar, lists, dialogs. A grotesque that stays
 *   legible at 13px.
 * - **Red Hat Mono** carries ids, byte sizes and `seq`, where columns of digits
 *   must not shuffle.
 *
 * ONE import statement, single-quoted, on purpose. `lib/identity.test.ts` and
 * `web/scripts/identity-distinct.mjs` parse it with the same regex; split it or
 * switch to double quotes and the cross-repo check reads zero faces from this repo
 * and reports success while checking nothing.
 */
const prose = Spectral({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-prose',
  // 400 body, 400 italic emphasis, 600 headings and titles. Every unused weight
  // is a file a reader downloads and never sees.
  weight: ['400', '600'],
  style: ['normal', 'italic'],
});

const ui = Karla({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-ui',
  weight: ['400', '500', '700'],
});

const mono = Red_Hat_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  weight: ['400'],
});

export const metadata: Metadata = {
  title: { default: 'collab-docs', template: '%s | collab-docs' },
  description:
    'A collaborative document editor: Yjs CRDT sync across replicas, an append-only update log ' +
    'that survives kill -9, server-enforced read-only roles, version history and offline merge.',
};

/**
 * `color-scheme` makes the browser paint its own furniture (scrollbars, form
 * controls) in the scheme the stylesheet is using. Without it a dark page keeps a
 * white scrollbar, the one part of the page CSS cannot reach.
 */
export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${prose.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        {/* First focusable element on every page. Every page renders a
            `<main id="main">`, so the target always exists; a skip link pointing
            at nothing moves focus to the document root and the reader loses
            their place. */}
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
