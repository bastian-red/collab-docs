import {
  DEMO_DOCUMENT,
  DEMO_NAME,
  EDITOR_EMAIL,
  EDITOR_NAME,
  asPerson,
  documentText,
  editorOf,
  expect,
  openDemoDocument,
  signIn,
  test,
  typeAtEnd,
} from '../fixtures';

const unique = (label: string) =>
  `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

test.describe('two people in one document', () => {
  test('edits from each side arrive at the other, and both end up with the same text', async ({
    page,
    browser,
  }) => {
    await signIn(page);
    await openDemoDocument(page);
    const theo = await asPerson(browser, EDITOR_EMAIL);
    await openDemoDocument(theo);

    const fromIris = unique('From Iris');
    const fromTheo = unique('From Theo');
    await typeAtEnd(page, fromIris);
    await typeAtEnd(theo, fromTheo);

    for (const reader of [page, theo]) {
      await expect(editorOf(reader)).toContainText(fromIris);
      await expect(editorOf(reader)).toContainText(fromTheo);
    }
    // Convergence, not just delivery: the two documents are the same document.
    await expect
      .poll(async () => (await documentText(page)) === (await documentText(theo)))
      .toBe(true);
    await expect(page.getByText('Synced', { exact: true })).toBeVisible();
    await theo.context().close();
  });

  test("a writer's caret carries their name, readable as text, never colour alone", async ({
    page,
    browser,
  }) => {
    await signIn(page);
    await openDemoDocument(page);
    const theo = await asPerson(browser, EDITOR_EMAIL);
    await openDemoDocument(theo);

    await editorOf(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await editorOf(theo).click();

    // By accessible text inside the document, which is what a screen reader and
    // a screenshot both get (docs/DESIGN.md 5.3).
    await expect(editorOf(theo).getByText(DEMO_NAME, { exact: true })).toBeVisible();
    await expect(editorOf(page).getByText(EDITOR_NAME, { exact: true })).toBeVisible();
    // And the participants list names both people.
    await expect(page.getByRole('list', { name: /here now/u })).toContainText(EDITOR_NAME);
    await theo.context().close();
  });

  test('edits survive a reload, because they reached the server rather than the tab', async ({
    page,
  }) => {
    await signIn(page);
    await openDemoDocument(page);
    const text = unique('Durable');
    await typeAtEnd(page, text);
    await expect(page.getByText('Synced', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Synced', { exact: true })).toBeVisible();
    await expect(editorOf(page)).toContainText(text);
  });

  test('the browser never calls the API directly; only the socket leaves the page', async ({
    page,
  }) => {
    const apiPort = process.env.API_PORT ?? '4000';
    const direct: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).port === apiPort) direct.push(request.url());
    });
    await signIn(page);
    await openDemoDocument(page);
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByRole('heading', { name: 'Version history' })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    // docs/SPECS.md 12.3: reads are server components, writes are server actions.
    expect(direct).toEqual([]);
  });

  test('renaming changes the heading for everybody who opens it next', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'New document' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Untitled document' })).toBeVisible();
    const title = unique('Renamed');
    await page.getByRole('button', { name: /^Rename/u }).click();
    await page.getByLabel('Document title').fill(title);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('link', { name: title })).toBeVisible();
    // The demo document is untouched by this.
    await expect(page.getByRole('link', { name: DEMO_DOCUMENT }).first()).toBeVisible();
  });
});
