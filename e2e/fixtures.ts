/**
 * What every spec needs: the seeded facts, a signed-in page, and other people.
 *
 * The seeded values are **read out of `packages/db/prisma/seed.mts`**, never
 * retyped. A copy that drifts produces a spec asserting confidently on data that
 * no longer exists, which fails like a product bug and is a test bug. The seed
 * declares them as one-line constants for exactly this; `scripts/seed-check.sh`
 * and `scripts/dev-smoke.sh` read them the same way.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test as base, type Browser, type Page } from '@playwright/test';

const SEED = readFileSync(join(__dirname, '..', 'packages', 'db', 'prisma', 'seed.mts'), 'utf8');

function seedConst(name: string): string {
  const match = new RegExp(`^const ${name} = '([^']*)';`, 'm').exec(SEED);
  if (!match) throw new Error(`Could not read ${name} out of packages/db/prisma/seed.mts.`);
  return match[1]!;
}

export const DEMO_EMAIL = seedConst('DEMO_EMAIL');
export const DEMO_PASSWORD = seedConst('DEMO_PASSWORD');
export const DEMO_DOCUMENT = seedConst('DEMO_DOCUMENT');
export const DEMO_PARAGRAPH = seedConst('DEMO_PARAGRAPH');
export const EDITOR_EMAIL = seedConst('EDITOR_EMAIL');
export const VIEWER_EMAIL = seedConst('VIEWER_EMAIL');
export const SEED_SHARE_TOKEN = seedConst('SEED_SHARE_TOKEN');

/** Names, read from the USERS block, so a caret label assertion uses the seeded spelling. */
function seedName(email: string): string {
  const constant =
    email === DEMO_EMAIL ? 'DEMO_EMAIL' : email === EDITOR_EMAIL ? 'EDITOR_EMAIL' : 'VIEWER_EMAIL';
  const match = new RegExp(`email: ${constant}, name: '([^']*)'`).exec(SEED);
  if (!match) throw new Error(`Could not read the name for ${constant} out of the seed.`);
  return match[1]!;
}
export const DEMO_NAME = seedName(DEMO_EMAIL);
export const EDITOR_NAME = seedName(EDITOR_EMAIL);
export const VIEWER_NAME = seedName(VIEWER_EMAIL);

/**
 * Sign in through the real form, located by role and accessible name.
 *
 * Not by forging a cookie: the form exercises Auth.js, the credentials provider
 * and the API's sign-in route, and a fixture that skipped them would keep passing
 * after any of them broke. Labels, never CSS classes: a field that loses its label
 * breaks a spec instead of silently becoming unreachable to a screen reader.
 */
export async function signIn(page: Page, email = DEMO_EMAIL, next?: string) {
  await page.goto(next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

/** Open the seeded demo document from the list, and wait for the socket, not just the render. */
export async function openDemoDocument(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: DEMO_DOCUMENT }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: DEMO_DOCUMENT })).toBeVisible();
  await expect(page.getByText('Synced', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(editorOf(page)).toContainText(DEMO_PARAGRAPH);
}

/** The editor's contenteditable, by its role and the document title it is named after. */
export function editorOf(page: Page) {
  return page.getByRole('textbox', { name: DEMO_DOCUMENT });
}

/**
 * Another signed-in person in their own CONTEXT.
 *
 * A context, not a second page: two pages in one context share a cookie jar and
 * an IndexedDB, so they are one person, and a spec using them would prove that a
 * browser can render a document twice, not that two people converge.
 */
export async function asPerson(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

/**
 * The demo document's id, read from the owner's own list rather than retyped or
 * re-derived from the seed's id formula: a copy of the formula is a second
 * definition that can drift, and a hand-typed id is one character from wrong.
 */
export async function demoDocumentId(browser: Browser): Promise<string> {
  const owner = await asPerson(browser, DEMO_EMAIL);
  const href = await owner.getByRole('link', { name: DEMO_DOCUMENT }).first().getAttribute('href');
  await owner.context().close();
  const id = href?.split('/').pop();
  if (!id) throw new Error('The demo document is not in its owner list.');
  return id;
}

/**
 * Put the caret at the very end of the document and start a new paragraph.
 *
 * By clicking the end of the last block rather than pressing Ctrl+End: headless
 * Chromium left the caret where the click landed, and the typed text was spliced
 * into the start of a paragraph in the middle of the document.
 */
export async function typeAtEnd(page: Page, text: string, name = DEMO_DOCUMENT) {
  const editor = page.getByRole('textbox', { name });
  const last = editor.locator(':scope > *').last();
  await last.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

/**
 * The document text as a reader sees it, without the remote caret labels.
 *
 * Caret labels are text inside the editor (that is the point of them: a screen
 * reader and a screenshot both get the name), so two converged documents differ in
 * innerText by exactly the other person's name. Convergence is about the document.
 */
export async function documentText(page: Page, name = DEMO_DOCUMENT): Promise<string> {
  return page.getByRole('textbox', { name }).evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const caret of copy.querySelectorAll('.caret')) caret.remove();
    return copy.innerText;
  });
}

/**
 * A switch for the page's connection to the sync server.
 *
 * `context.setOffline(true)` in Chromium does not close a websocket that is
 * already open, so the editor kept saying "Synced" and kept syncing. This routes
 * the socket through Playwright: online, frames pass straight through to the real
 * server; `offline()` closes both ends with a transport code (1001, which the app
 * reads as offline rather than refused) and refuses every reconnect until
 * `online()`. HTTP is taken offline with the context as well, so the token route
 * fails too, exactly as on a dead network.
 */
export async function controllableNetwork(page: Page) {
  let isOffline = false;
  const open = new Set<{ close: () => Promise<void> }>();
  await page.routeWebSocket(/:\d+\/?(\?.*)?$/u, (ws) => {
    if (isOffline) {
      void ws.close({ code: 1001, reason: 'offline' });
      return;
    }
    const server = ws.connectToServer();
    const pair = {
      close: async () => {
        await ws.close({ code: 1001, reason: 'offline' }).catch(() => undefined);
        await server.close().catch(() => undefined);
      },
    };
    open.add(pair);
  });
  return {
    async offline() {
      isOffline = true;
      await page.context().setOffline(true);
      for (const pair of open) await pair.close();
      open.clear();
    },
    async online() {
      isOffline = false;
      await page.context().setOffline(false);
    },
  };
}

/**
 * Every spec fails on an uncaught error in the page.
 *
 * Without it a client component can throw on every render, leave a blank region
 * behind, and the spec still passes because the element it asserts on was
 * rendered by the server. Auto-applied, so no spec can forget it.
 */
export const test = base.extend<{ failOnPageError: void }>({
  failOnPageError: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await use();
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
