import { expect, test } from '@playwright/test';
import { apiCall, enrolTotp, expectAccessible, fillAccountForm, register, uniq, type Account } from './helpers';

test('Helpers: invitation, Actor and date scope, redaction, read-only, Add, Incident scope and export', async ({ page, browser }) => {
  await register(page, 'Olive Owner');
  const barclays = await apiCall<{ id: string }>(page, 'POST', '/actors', { name: 'Barclays' });
  const debtco = await apiCall<{ id: string }>(page, 'POST', '/actors', { name: 'DebtCo Collections', description: 'Private notes about DebtCo' });
  await apiCall(page, 'POST', '/events', { typeId: 'letter_in', title: 'Old Barclays statement', occurredAt: '2025-06-01', actors: [{ actorId: barclays.id }] });
  const letter = await apiCall<{ id: string }>(page, 'POST', '/events', { typeId: 'letter_in', title: 'Collector letter about Barclays debt', occurredAt: '2026-02-10', actors: [{ actorId: barclays.id }, { actorId: debtco.id }] });
  const call = await apiCall<{ id: string }>(page, 'POST', '/events', { typeId: 'phone_call', title: 'DebtCo phone call', occurredAt: '2026-03-05', actors: [{ actorId: debtco.id }] });
  const incident = await apiCall<{ id: string }>(page, 'POST', '/incidents', { title: 'Arrears problem', eventIds: [letter.id, call.id] });

  // Owner invites a Helper scoped to Barclays from 1 January 2026, view only.
  await page.goto('/settings/helpers');
  await page.getByRole('button', { name: 'Invite a Helper' }).click();
  await page.getByLabel('Who are they?').fill('Sam (support worker)');
  await page.getByLabel('Barclays').check();
  await page.getByLabel('From').fill('2026-01-01');
  await expectAccessible(page, 'invite a Helper');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const inviteUrl = (await page.locator('.alert .mono').textContent())!.trim();
  expect(inviteUrl).toContain('/invite/');

  // The Helper accepts in a separate browser and creates an account.
  const helperContext = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London' });
  const helper = await helperContext.newPage();
  await helper.goto(new URL(inviteUrl).pathname);
  await expect(helper.getByRole('heading', { name: 'Help Olive Owner with their record' })).toBeVisible();
  await expect(helper.getByText(/Events involving Barclays from 2026-01-01 onwards \(view\)/)).toBeVisible();
  await expectAccessible(helper, 'invitation');
  const helperAccount: Account = { username: uniq('helper'), displayName: 'Sam Helper', secret: '', recoveryCodes: [], lastEpoch: 0 };
  await fillAccountForm(helper, helperAccount.username, helperAccount.displayName);
  await helper.getByRole('button', { name: 'Create account and accept' }).click();
  await enrolTotp(helper, helperAccount);
  await expect(helper.getByText(/You are helping with Olive Owner/)).toBeVisible();

  // Only the in-scope Event is visible; the co-Actor is redacted; no Add.
  await expect(helper.getByRole('link', { name: 'Collector letter about Barclays debt' })).toBeVisible();
  await expect(helper.getByRole('link', { name: 'Old Barclays statement' })).toHaveCount(0);
  await expect(helper.getByRole('link', { name: 'DebtCo phone call' })).toHaveCount(0);
  await expect(helper.getByRole('link', { name: 'Add Event' })).toHaveCount(0);
  await expect(helper.getByText('DebtCo')).toHaveCount(0);
  await helper.getByRole('link', { name: 'Collector letter about Barclays debt' }).click();
  await expect(helper.getByText('Another Actor, not shared with you')).toBeVisible();
  await expect(helper.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expectAccessible(helper, 'helper event view');

  // Direct URLs to out-of-scope records are refused as not found.
  await helper.goto(`/events/${call.id}`);
  await expect(helper.getByRole('alert')).toContainText('Event not found');
  await helper.goto(`/actors/${debtco.id}`);
  await expect(helper.getByRole('alert')).toContainText('Actor not found');
  await helper.goto(`/incidents/${incident.id}`);
  await expect(helper.getByRole('alert')).toContainText('Incident not found');
  await helper.goto('/search?q=DebtCo');
  await expect(helper.getByRole('status').filter({ hasText: /for “DebtCo”/ })).toBeVisible();
  await expect(helper.getByRole('link', { name: 'DebtCo phone call' })).toHaveCount(0);
  await expect(helper.getByRole('heading', { name: /^Actors \(/ })).toHaveCount(0);
  await expect(helper.getByRole('link', { name: /DebtCo Collections/ })).toHaveCount(0);
  await helper.goto('/settings/export');
  await expect(helper.getByText('does not include exporting')).toBeVisible();

  // Owner adds Incident access with Add and Export.
  const helpers = await apiCall<{ items: { id: string }[] }>(page, 'GET', '/settings/helpers');
  await apiCall(page, 'POST', `/settings/helpers/${helpers.items[0]!.id}/grants`, { scopeType: 'incidents', incidentIds: [incident.id], canAdd: true, canExport: true });
  await helper.goto('/');
  await expect(helper.getByRole('link', { name: 'DebtCo phone call' })).toBeVisible();
  await expect(helper.getByRole('link', { name: 'Old Barclays statement' })).toHaveCount(0);

  // The Helper adds an Event inside the Incident.
  await helper.goto('/events/new/phone_call');
  await helper.getByLabel('Title').fill('Helper called DebtCo');
  await helper.getByLabel('Date', { exact: true }).fill('2026-03-20');
  await helper.getByText(/More details/).click();
  await helper.getByLabel('Add to Incident').selectOption({ label: 'Arrears problem' });
  await helper.getByRole('button', { name: 'Save Event' }).click();
  await expect(helper.getByRole('heading', { level: 1, name: 'Helper called DebtCo' })).toBeVisible();
  await expect(helper.getByText(/by Sam Helper/).first()).toBeVisible();

  // The Helper can now export what the Incident grant covers.
  await helper.goto('/settings/export');
  const download = helper.waitForEvent('download');
  await helper.getByRole('link', { name: 'Download export' }).click();
  expect((await download).suggestedFilename()).toMatch(/openrampart-export-.*\.zip/);

  // The owner sees the Helper's Event, attributed to them.
  await page.goto('/');
  await page.getByRole('link', { name: 'Helper called DebtCo' }).click();
  await expect(page.getByText(/by Sam Helper/).first()).toBeVisible();
  await helperContext.close();
});
