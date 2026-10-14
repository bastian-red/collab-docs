import type { Page } from '@playwright/test';

import {
  DEMO_DOCUMENT,
  EDITOR_EMAIL,
  EDITOR_NAME,
  DEMO_NAME,
  asPerson,
  editorOf,
  expect,
  openDemoDocument,
  signIn,
  test,
  typeAtEnd,
} from '../fixtures';

/**
 * Frames for assets/demo.gif. Not a check: testIgnore skips it unless DEMO=1,
 * and scripts/demo-gif.sh is the only thing that runs it.
 *
 * Each step is a PAIR, `NN-step.a.png` (Iris) and `NN-step.b.png` (Theo), which
 * demo-gif.sh joins side by side: the claim being shown is two people converging
 * on one document with each other's name on the caret, and one viewport cannot
 * show that.
 */
const VIEWPORT = { width: 880, height: 760 };

async function pair(a: Page, b: Page, name: string) {
  await a.screenshot({ path: `demo-shots/${name}.a.png` });
  await b.screenshot({ path: `demo-shots/${name}.b.png` });
}

test('two people, one document', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await signIn(page);
  await expect(page.getByRole('link', { name: DEMO_DOCUMENT }).first()).toBeVisible();
  await page.screenshot({ path: 'demo-shots/01-list.png' });

  const theo = await asPerson(browser, EDITOR_EMAIL);
  await theo.setViewportSize(VIEWPORT);
  await openDemoDocument(page);
  await openDemoDocument(theo);
  await pair(page, theo, '02-both-open');

  await typeAtEnd(page, 'Iris: the log is the durable copy, not the checkpoint.');
  await expect(editorOf(theo)).toContainText('the log is the durable copy');
  await expect(editorOf(theo).getByText(DEMO_NAME, { exact: true })).toBeVisible();
  await pair(page, theo, '03-iris-types');

  await typeAtEnd(theo, 'Theo: and a viewer is read-only at the server.');
  await expect(editorOf(page)).toContainText('read-only at the server');
  await expect(editorOf(page).getByText(EDITOR_NAME, { exact: true })).toBeVisible();
  await pair(page, theo, '04-theo-types');

  await page.getByRole('button', { name: 'History' }).click();
  await page.locator('.version-button').first().click();
  await expect(page.getByRole('heading', { name: /Changes since version/u })).toBeVisible();
  await page.screenshot({ path: 'demo-shots/05-history.png' });

  await page.goto('/status');
  await expect(page.getByText('All services operational')).toBeVisible();
  await page.screenshot({ path: 'demo-shots/06-status.png' });
  await theo.context().close();
});
