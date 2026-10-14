import { DEMO_DOCUMENT, expect, signIn, test } from '../fixtures';

test.describe('full-text search', () => {
  test('finds the seeded document by a word in its body and highlights the hit', async ({
    page,
  }) => {
    await signIn(page);
    const box = page.getByRole('searchbox', { name: 'Search full text' });
    // Retried until hydration has attached the shortcut: a key pressed before the
    // listener exists goes nowhere, which is a test timing fact, not a product one.
    await expect(async () => {
      await page.locator('body').press('/');
      await expect(box).toBeFocused({ timeout: 500 });
    }).toPass();
    await box.fill('');
    await page.keyboard.type('debounced');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Search results' })).toBeVisible();
    const results = page.getByRole('list', { name: /results for debounced/u });
    await expect(results.getByRole('link', { name: DEMO_DOCUMENT })).toBeVisible();
    // The `[[ ]]` markers became a <mark>, not literal brackets and not HTML.
    await expect(results.locator('mark').first()).toHaveText(/debounce/iu);
    await expect(results).not.toContainText('[[');
  });

  test('never errors on what a person types into a search box', async ({ page }) => {
    await signIn(page);
    for (const query of ['a & b', '"unbalanced', 'and', '!!!']) {
      await page.goto(`/?q=${encodeURIComponent(query)}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Search results' })).toBeVisible();
      await expect(page.locator('.panel-error')).toHaveCount(0);
    }
  });
});
