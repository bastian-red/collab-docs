import { DEMO_DOCUMENT, DEMO_EMAIL, DEMO_PASSWORD, expect, signIn, test } from '../fixtures';

test.describe('signing in and out', () => {
  test('a wrong password is refused without saying which half was wrong', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(DEMO_EMAIL);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.form-error')).toHaveText(
      'That email address and password do not match.',
    );
    await expect(page).toHaveURL(/\/sign-in/u);
  });

  test('an unknown address gets the identical sentence', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('nobody@collab.test');
    await page.getByLabel('Password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.form-error')).toHaveText(
      'That email address and password do not match.',
    );
  });

  test('a signed-out deep link comes back to where it was going after sign-in', async ({
    page,
  }) => {
    await page.goto('/?view=trash');
    await expect(page).toHaveURL(/\/sign-in\?next=/u);
    await page.getByLabel('Email').fill(DEMO_EMAIL);
    await page.getByLabel('Password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Trash' })).toBeVisible();
  });

  test('a crafted next parameter cannot send a reader off-site', async ({ page }) => {
    await signIn(page, DEMO_EMAIL, '//evil.example/steal');
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/u);
    await expect(page.getByRole('heading', { level: 1, name: 'All documents' })).toBeVisible();
  });

  test('a new account signs up, lands on an empty list, and can sign out', async ({ page }) => {
    const email = `new-${Date.now()}-${Math.floor(Math.random() * 1e6)}@collab.test`;
    await page.goto('/sign-up');
    await page.getByLabel('Name').fill('Nora Fresh');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-long-enough-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'All documents' })).toBeVisible();
    await expect(page.getByText('No documents yet.', { exact: false })).toBeVisible();
    // Somebody else's document is not in a stranger's list.
    await expect(page.getByRole('link', { name: DEMO_DOCUMENT })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in/u);
  });

  test('a short password is refused before it leaves the page', async ({ page }) => {
    await page.goto('/sign-up');
    await page.getByLabel('Name').fill('Short');
    await page.getByLabel('Email').fill('short@collab.test');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    // The native minLength refusal: the form never submits, so no account exists.
    await expect(page).toHaveURL(/\/sign-up/u);
    expect(
      await page
        .getByLabel('Password')
        .evaluate((input: HTMLInputElement) => input.validity.tooShort),
    ).toBe(true);
  });
});
