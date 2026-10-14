import { EDITOR_EMAIL, asPerson, expect, signIn, test, typeAtEnd } from '../fixtures';

const unique = (label: string) =>
  `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/**
 * docs/SPECS.md 5: a labelled version, a diff, and a restore that every other
 * connected writer converges on. Runs on a document it creates, so restoring
 * cannot take text away from any other spec.
 */
test('save a version, change the text, restore it, and a second writer converges on the restore', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByText('Synced', { exact: true })).toBeVisible();
  const url = page.url();
  const editor = page.getByRole('textbox', { name: 'Untitled document' });

  const kept = unique('Kept paragraph');
  const later = unique('Written after the version');
  await editor.click();
  await page.keyboard.type(kept);
  await expect(page.getByText('Synced', { exact: true })).toBeVisible();

  // Share with Theo through the dialog, so a second writer can watch the restore.
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByLabel('Add people by email').fill(EDITOR_EMAIL);
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(
    page.getByRole('dialog').locator('.share-person-name', { hasText: 'Theo Nakamura' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  const label = unique('Before the rewrite');
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByLabel('Save a version').fill(label);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = page.locator('.version').filter({ hasText: label });
  await expect(saved).toContainText('Labelled, never pruned');
  await page.getByRole('button', { name: 'Close' }).click();

  await typeAtEnd(page, later, 'Untitled document');
  await expect(page.getByText('Synced', { exact: true })).toBeVisible();

  const theo = await asPerson(browser, EDITOR_EMAIL);
  await theo.goto(url);
  const theoEditor = theo.getByRole('textbox', { name: 'Untitled document' });
  await expect(theoEditor).toContainText(later);

  // The diff names what changed since the version, with a word as well as a colour.
  await page.getByRole('button', { name: 'History' }).click();
  await page.locator('.version').filter({ hasText: label }).getByRole('button').click();
  await expect(page.getByRole('heading', { name: /Changes since version/u })).toBeVisible();
  await expect(page.locator('ins', { hasText: later })).toBeVisible();

  await page.getByRole('button', { name: /^Restore v/u }).click();
  const confirm = page.getByRole('dialog', { name: /Restore version/u });
  await expect(confirm).toContainText('will be lost');
  await confirm.getByRole('button', { name: 'Restore' }).click();

  const mine = page.getByRole('textbox', { name: 'Untitled document' });
  await expect(mine).toContainText(kept);
  await expect(mine).not.toContainText(later);
  // A restore is an ordinary edit, so the other writer converges on it.
  await expect(theoEditor).not.toContainText(later);
  await expect(theoEditor).toContainText(kept);
  await theo.context().close();
});
