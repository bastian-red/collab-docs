import {
  DEMO_DOCUMENT,
  DEMO_PARAGRAPH,
  SEED_SHARE_TOKEN,
  VIEWER_EMAIL,
  asPerson,
  demoDocumentId,
  editorOf,
  expect,
  openDemoDocument,
  signIn,
  test,
  typeAtEnd,
} from '../fixtures';

const unique = (label: string) =>
  `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

test.describe('read-only is enforced by the server, and explained by the page', () => {
  test('a viewer sees the document live, cannot change it, and is told why', async ({
    page,
    browser,
  }) => {
    const viewer = await asPerson(browser, VIEWER_EMAIL);
    await viewer.goto('/');
    await viewer.getByRole('link', { name: DEMO_DOCUMENT }).first().click();
    await expect(viewer.getByText('Viewing only.', { exact: false })).toBeVisible();
    await expect(editorOf(viewer)).toContainText(DEMO_PARAGRAPH);
    await expect(editorOf(viewer)).toHaveAttribute('contenteditable', 'false');
    await expect(viewer.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'History' })).toHaveCount(0);

    // The owner types; the viewer follows along live.
    await signIn(page);
    await openDemoDocument(page);
    const live = unique('Seen by the viewer');
    await typeAtEnd(page, live);
    await expect(editorOf(viewer)).toContainText(live);

    // Typing into a read-only editor changes nothing, here or for the owner.
    await editorOf(viewer).click();
    await viewer.keyboard.type('viewer was here');
    await expect(editorOf(viewer)).not.toContainText('viewer was here');
    await expect(editorOf(page)).not.toContainText('viewer was here');
    await viewer.context().close();
  });

  test('a share link opens the document read-only for somebody who is not a member', async ({
    page,
    browser,
  }) => {
    const id = await demoDocumentId(browser);
    const email = `link-${Date.now()}-${Math.floor(Math.random() * 1e6)}@collab.test`;
    await page.goto('/sign-up');
    await page.getByLabel('Name').fill('Lin Reader');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-long-enough-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'All documents' })).toBeVisible();

    await page.goto(`/d/${id}?share=${SEED_SHARE_TOKEN}`);
    await expect(page.getByRole('heading', { level: 1, name: DEMO_DOCUMENT })).toBeVisible();
    await expect(page.getByText('Viewing only.', { exact: false })).toBeVisible();
    await expect(editorOf(page)).toContainText(DEMO_PARAGRAPH);
    await expect(page.getByText('Synced', { exact: true })).toBeVisible();
  });

  test('a revoked link, an unknown link and no link all look like a missing document', async ({
    page,
    browser,
  }) => {
    const id = await demoDocumentId(browser);
    const email = `nolink-${Date.now()}-${Math.floor(Math.random() * 1e6)}@collab.test`;
    await page.goto('/sign-up');
    await page.getByLabel('Name').fill('No Access');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-long-enough-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'All documents' })).toBeVisible();

    for (const suffix of [
      `?share=${SEED_SHARE_TOKEN}-revoked`,
      '?share=unknown-token-0000000000',
      '',
    ]) {
      await page.goto(`/d/${id}${suffix}`);
      // One page for all three: distinguishing them would tell a guesser which
      // tokens and ids are real (docs/SPECS.md 4.5).
      await expect(
        page.getByRole('heading', { level: 1, name: 'Document not found' }),
      ).toBeVisible();
    }
  });
});
