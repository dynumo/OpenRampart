import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { generate } from 'otplib';

export const PASSWORD = 'a long enough passphrase';

export interface Account {
  username: string;
  displayName: string;
  secret: string;
  recoveryCodes: string[];
  lastEpoch: number;
}

export function uniq(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

/** A TOTP code that has not been used yet for this account (replay protection). */
export async function freshCode(account: Account): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let epoch = Math.max(now, account.lastEpoch + 30);
  if (epoch > now + 25) {
    await new Promise((r) => setTimeout(r, (epoch - now - 25) * 1000));
    epoch = Math.max(Math.floor(Date.now() / 1000), account.lastEpoch + 30);
  }
  account.lastEpoch = epoch;
  return generate({ secret: account.secret, epoch });
}

/** Complete authenticator enrolment on the setup page, reading the manual key from the screen. */
export async function enrolTotp(page: Page, account: Pick<Account, 'secret' | 'recoveryCodes' | 'lastEpoch'>) {
  await page.getByText('Cannot scan the code?').click();
  const key = (await page.locator('details .mono').first().textContent())!.replace(/\s/g, '');
  account.secret = key;
  account.lastEpoch = Math.floor(Date.now() / 1000);
  await page.getByLabel('Code from the app').fill(await generate({ secret: key, epoch: account.lastEpoch }));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  account.recoveryCodes = (await page.locator('.recovery-codes li').allTextContents()).map((c) => c.trim());
  expect(account.recoveryCodes).toHaveLength(10);
  await page.getByLabel('I have saved my recovery codes').check();
  await page.getByRole('button', { name: 'Continue' }).click();
}

export async function fillAccountForm(page: Page, username: string, displayName: string) {
  await page.getByLabel('Your name').fill(displayName);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
}

export async function register(page: Page, displayName = 'Alex Example'): Promise<Account> {
  const account: Account = { username: uniq('user'), displayName, secret: '', recoveryCodes: [], lastEpoch: 0 };
  await page.goto('/register');
  await fillAccountForm(page, account.username, displayName);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  await enrolTotp(page, account);
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
  return account;
}

export async function signIn(page: Page, account: Account, secondFactor?: string) {
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(account.username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Code from your authenticator app').fill(secondFactor ?? (await freshCode(account)));
  await page.getByRole('button', { name: 'Continue' }).click();
}

export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.waitForLoadState('load');
}

export async function newSignedInContext(browser: Browser, account: Account, mobile = false): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'en-GB', timezoneId: 'Europe/London' } : { locale: 'en-GB', timezoneId: 'Europe/London' },
  );
  const page = await context.newPage();
  await signIn(page, account);
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
  return { context, page };
}

/** WCAG 2.2 AA automated checks. Automated testing complements, not replaces, manual review. */
export async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
  expect(summary, `Accessibility violations on ${label}`).toEqual([]);
}

export async function createEventViaUi(page: Page, opts: { type: string; title: string; date?: string; actor?: string; newActor?: boolean; notes?: string }) {
  await page.goto(`/events/new/${opts.type}`);
  await page.getByLabel('Title').fill(opts.title);
  if (opts.date) await page.getByLabel('Date', { exact: true }).fill(opts.date);
  if (opts.actor) {
    await page.getByLabel('Actors', { exact: true }).fill(opts.actor);
    if (opts.newActor) await page.getByRole('button', { name: `Create new Actor “${opts.actor}”` }).click();
    else await page.getByRole('button', { name: new RegExp(`^Add ${opts.actor}`) }).first().click();
  }
  if (opts.notes) await page.getByLabel('Notes').fill(opts.notes);
  await page.getByRole('button', { name: 'Save Event' }).click();
  await expect(page.getByRole('heading', { level: 1, name: opts.title })).toBeVisible();
  return page.url().split('/events/')[1]!.split('?')[0]!;
}

/** Call the JSON API from a signed-in page (shares the browser session and CSRF token). */
export async function apiCall<T = unknown>(page: Page, method: string, path: string, body?: unknown, record?: string): Promise<T> {
  const state = await (await page.request.get('/api/auth/state')).json();
  const res = await page.request.fetch(`/api${path}`, {
    method,
    headers: { 'X-CSRF-Token': state.csrfToken ?? '1', ...(record ? { 'X-OpenRampart-Record': record } : {}) },
    data: body,
  });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}
