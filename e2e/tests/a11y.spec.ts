import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';

import { DEMO_DOCUMENT, expect, openDemoDocument, signIn, test, VIEWER_EMAIL } from '../fixtures';

/**
 * axe over every route and every opened surface, both colour schemes, zero
 * violations, no rule exclusions (docs/DESIGN.md 7).
 *
 * Both schemes because the palette differs in each: the dark block overrides a
 * subset of the light one, and a contrast failure that exists only in dark is
 * invisible to a suite that runs in light. No `disableRules`: an excluded rule is
 * a violation somebody decided not to see, and the exclusion outlives the reason.
 *
 * Under `BASELINE=1` it records instead of failing, because a baseline is wanted
 * at exactly the moment the app is failing (before the stylesheet exists).
 * `scripts/a11y-summary.mjs` reads the attachment, so its shape is a contract.
 */
const SCHEMES = ['light', 'dark'] as const;
const RECORDING = process.env.BASELINE === '1';

async function scan(page: Page, testInfo: TestInfo, route: string, scheme: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  if (RECORDING) {
    await testInfo.attach('a11y', {
      contentType: 'application/json',
      body: JSON.stringify({ route, scheme, violations: results.violations }),
    });
    return;
  }

  // The list itself, not a count: rule ids and failing nodes save the debugging
  // session that "expected 0, got 2" costs.
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

for (const scheme of SCHEMES) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('sign in', async ({ page }, testInfo) => {
      await page.goto('/sign-in');
      await scan(page, testInfo, '/sign-in', scheme);
    });

    test('sign up', async ({ page }, testInfo) => {
      await page.goto('/sign-up');
      await scan(page, testInfo, '/sign-up', scheme);
    });

    test('status', async ({ page }, testInfo) => {
      await page.goto('/status');
      await scan(page, testInfo, '/status', scheme);
    });

    test('document list', async ({ page }, testInfo) => {
      await signIn(page);
      await expect(page.getByRole('heading', { level: 1, name: 'All documents' })).toBeVisible();
      await scan(page, testInfo, '/', scheme);
    });

    test('search results', async ({ page }, testInfo) => {
      await signIn(page);
      await page.goto('/?q=debounced');
      await expect(page.getByRole('heading', { level: 1, name: 'Search results' })).toBeVisible();
      await scan(page, testInfo, '/?q=', scheme);
    });

    test('trash', async ({ page }, testInfo) => {
      await signIn(page);
      await page.goto('/?view=trash');
      await scan(page, testInfo, '/?view=trash', scheme);
    });

    test('editor', async ({ page }, testInfo) => {
      await signIn(page);
      await openDemoDocument(page);
      await scan(page, testInfo, '/d/:id', scheme);
    });

    test('editor, read-only', async ({ page }, testInfo) => {
      await signIn(page, VIEWER_EMAIL);
      await page.goto('/');
      await page.getByRole('link', { name: DEMO_DOCUMENT }).first().click();
      await expect(page.getByText('Viewing only.', { exact: false })).toBeVisible();
      await expect(page.getByText('Synced', { exact: true })).toBeVisible({ timeout: 20_000 });
      await scan(page, testInfo, '/d/:id (viewer)', scheme);
    });

    test('version history and a diff', async ({ page }, testInfo) => {
      await signIn(page);
      await openDemoDocument(page);
      await page.getByRole('button', { name: 'History' }).click();
      await page.locator('.version-button').first().click();
      await expect(page.getByRole('heading', { name: /Changes since version/u })).toBeVisible();
      await scan(page, testInfo, '/d/:id history', scheme);
    });

    test('share dialog', async ({ page }, testInfo) => {
      await signIn(page);
      await openDemoDocument(page);
      await page.getByRole('button', { name: 'Share' }).click();
      await expect(page.getByRole('heading', { name: 'People with access' })).toBeVisible();
      await scan(page, testInfo, '/d/:id share', scheme);
    });

    test('not found', async ({ page }, testInfo) => {
      await signIn(page);
      await page.goto('/d/cdocdoesnotexist000000000');
      await expect(page.getByRole('heading', { name: 'Document not found' })).toBeVisible();
      await scan(page, testInfo, '404', scheme);
    });
  });
}
