import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  fillAccountForm,
  freshCode,
  register,
  signIn,
  signOut,
  uniq,
} from './helpers';

test.describe('Accounts, TOTP, recovery codes and sessions', () => {
  test('account creation with TOTP setup is accessible', async ({ page }) => {
    await page.goto('/register');
    await expectAccessible(page, 'registration');
    await page.getByRole('button', { name: 'Create account' }).click();
    // Client-side check: passwords must match before submitting.
    await fillAccountForm(page, uniq('a11y'), 'Accessibility Check');
    await page.getByLabel('Confirm password').fill('different passphrase here');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('The passwords do not match.')).toBeVisible();
    await page.getByLabel('Confirm password').fill('a long enough passphrase');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await expectAccessible(page, 'TOTP setup');
  });

  test('TOTP sign-in, single-use recovery codes and audit log', async ({ page }) => {
    const account = await register(page);
    await signOut(page);
    await page.goto('/login');
    await expectAccessible(page, 'sign in');
    // Wrong second factor is refused.
    await page.getByLabel('Username or email').fill(account.username);
    await page.getByLabel('Password').fill('a long enough passphrase');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Code from your authenticator app').fill('123456');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('not correct');
    await expectAccessible(page, 'second factor');
    await page.getByLabel('Code from your authenticator app').fill(await freshCode(account));
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await signOut(page);

    const code = account.recoveryCodes[0]!;
    await signIn(page, account, code);
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await page.goto('/settings/security');
    await expect(page.getByText('9 unused recovery code(s) remaining')).toBeVisible();
    await expectAccessible(page, 'security settings');
    await signOut(page);
    await signIn(page, account, code);
    await expect(page.getByRole('alert')).toContainText('not correct');

    await page.getByLabel('Code from your authenticator app').fill(await freshCode(account));
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await page.goto('/settings/security/audit');
    await expect(page.getByRole('cell', { name: 'Recovery code used' }).first()).toBeVisible();
    await expect(
      page.getByRole('cell', { name: /Wrong authentication code/ }).first(),
    ).toBeVisible();
    await expectAccessible(page, 'audit log');
  });

  test('the colour theme can be chosen per device and is accessible in dark mode', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/settings/account');
    await page.getByLabel('Dark', { exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByLabel('Dark', { exact: true })).toBeChecked();
    await expectAccessible(page, 'account settings (dark)');
    await page.goto('/');
    await expectAccessible(page, 'timeline (dark)');
    await page.goto('/settings/account');
    await page.getByLabel('Match my device').check();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  });

  test('session revocation signs the other device out', async ({ page, browser }) => {
    const account = await register(page);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, account);
    await expect(otherPage.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await page.goto('/settings/security');
    await expect(page.getByText('This device')).toBeVisible();
    await page
      .getByRole('button', { name: /^Sign out Chrome|^Sign out .* on / })
      .first()
      .click();
    await expect(page.getByRole('status').filter({ hasText: 'Device signed out' })).toBeVisible();
    await otherPage.goto('/');
    await expect(otherPage.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await other.close();
  });
});
