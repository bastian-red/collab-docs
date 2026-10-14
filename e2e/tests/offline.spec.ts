import {
  EDITOR_EMAIL,
  asPerson,
  controllableNetwork,
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

/**
 * docs/SPECS.md 6: both people go offline, each types something different, both
 * reconnect, and both documents contain both edits. Nothing in the app does
 * anything special for this -- which is the point of a CRDT, and exactly why it
 * needs a test rather than a paragraph.
 */
test('two people edit offline and both edits survive the reconnect', async ({ page, browser }) => {
  const irisNet = await controllableNetwork(page);
  await signIn(page);
  await openDemoDocument(page);
  const theo = await asPerson(browser, EDITOR_EMAIL);
  const theoNet = await controllableNetwork(theo);
  await openDemoDocument(theo);

  await irisNet.offline();
  await theoNet.offline();
  // The pill says so in a word, not only a colour.
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await expect(theo.getByText('Offline', { exact: true })).toBeVisible();

  const fromIris = unique('Offline Iris');
  const fromTheo = unique('Offline Theo');
  await typeAtEnd(page, fromIris);
  await typeAtEnd(theo, fromTheo);
  // Neither has the other's words while the network is down.
  await expect(editorOf(page)).not.toContainText(fromTheo);
  await expect(editorOf(theo)).not.toContainText(fromIris);

  await irisNet.online();
  await theoNet.online();

  for (const reader of [page, theo]) {
    await expect(reader.getByText('Synced', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(editorOf(reader)).toContainText(fromIris, { timeout: 30_000 });
    await expect(editorOf(reader)).toContainText(fromTheo, { timeout: 30_000 });
  }
  await expect
    .poll(async () => (await documentText(page)) === (await documentText(theo)))
    .toBe(true);
  await theo.context().close();
});
