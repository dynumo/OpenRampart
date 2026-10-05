import { expect, test } from '@playwright/test';
import { createEventViaUi, expectAccessible, newSignedInContext, register } from './helpers';

test.describe('Recording Events, Actors and Incidents', () => {
  test('create Events and Actors, browse the Actor timeline, group into an Incident, search', async ({
    page,
  }) => {
    await register(page);
    await expectAccessible(page, 'empty timeline');
    await page.goto('/events/new');
    await expectAccessible(page, 'add event type picker');
    await page.goto('/events/new/payment');
    await expectAccessible(page, 'event form');

    const paid = await createEventViaUi(page, {
      type: 'payment',
      title: 'Payment made to Barclaycard',
      date: '2026-09-12',
      actor: 'Barclaycard',
      newActor: true,
      notes: 'Paid 250 pounds by bank transfer.',
    });
    await expectAccessible(page, 'event detail');
    await createEventViaUi(page, {
      type: 'observation',
      title: 'Payment missing from statement',
      date: '2026-09-15',
      actor: 'Barclaycard',
      notes: 'Online banking shows the September payment as missing.',
    });
    await createEventViaUi(page, {
      type: 'portal',
      title: 'Login unavailable',
      date: '2026-03-24',
      actor: 'Companies House',
      newActor: true,
    });

    // Global timeline shows everything with month grouping.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'September 2026' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Payment made to Barclaycard' })).toBeVisible();
    // Filter by date range.
    await page.getByText('Filter', { exact: true }).click();
    await page.getByLabel('From date').fill('2026-03-01');
    await page.getByLabel('To date').fill('2026-03-31');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByRole('link', { name: 'Login unavailable' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Payment made to Barclaycard' })).toHaveCount(0);

    // Actor timeline.
    await page.goto('/actors');
    await expectAccessible(page, 'actors list');
    await page.getByRole('link', { name: 'Barclaycard' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Barclaycard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Payment missing from statement' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Login unavailable' })).toHaveCount(0);
    await expectAccessible(page, 'actor timeline');

    // Create an Incident and link existing Events to it.
    await page.goto('/incidents/new');
    await page.getByLabel('Title').fill('Incorrect credit card arrears');
    await page.getByRole('button', { name: 'Create Incident' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Incorrect credit card arrears' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Add existing Events' }).click();
    await page.getByLabel(/Payment made to Barclaycard/).check();
    await page.getByLabel(/Payment missing from statement/).check();
    await page.getByRole('button', { name: /Add 2 selected/ }).click();
    await expect(page.getByRole('link', { name: 'Payment made to Barclaycard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Payment missing from statement' })).toBeVisible();
    await expectAccessible(page, 'incident timeline');

    // The Event links back to its Incident.
    await page.goto(`/events/${paid}`);
    await expect(page.getByRole('link', { name: 'Incorrect credit card arrears' })).toBeVisible();

    // Search by natural fragments.
    await page.goto('/search');
    await page.getByLabel('Search for').fill('Companies House login');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('link', { name: 'Login unavailable' })).toBeVisible();
    await page.getByLabel('Search for').fill('Barclaycard September payment');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('link', { name: 'Payment missing from statement' })).toBeVisible();
    await expect(page.getByText('Incident: Incorrect credit card arrears').first()).toBeVisible();
    await expectAccessible(page, 'search results');

    // Edit creates a revision.
    await page.goto(`/events/${paid}/edit`);
    await page.getByLabel('Title').fill('Payment of £250 made to Barclaycard');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Payment of £250 made to Barclaycard' }),
    ).toBeVisible();
    await page.getByText('Revision history (2)').click();
    await expect(page.getByText('Revision 1')).toBeVisible();
  });

  test('mobile timeline and navigation are accessible', async ({ page, browser }) => {
    const account = await register(page);
    await createEventViaUi(page, { type: 'note', title: 'A short note' });
    const { context, page: phone } = await newSignedInContext(browser, account, true);
    await expect(phone.getByRole('navigation', { name: 'Main (mobile)' })).toBeVisible();
    await expectAccessible(phone, 'mobile timeline');
    await context.close();
  });

  test('content reflows at 320 CSS pixels without horizontal scrolling (WCAG 1.4.10)', async ({
    page,
  }) => {
    await register(page);
    const id = await createEventViaUi(page, {
      type: 'letter_in',
      title: 'A letter with a fairly long title about a housing benefit overpayment review',
      actor: 'Department for Work and Pensions',
      newActor: true,
      notes: 'Reference HB/2026/000123456789. Asked for the decision to be looked at again.',
    });
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of ['/', `/events/${id}`, '/events/new/letter_in', '/search', '/settings']) {
      await page.goto(path);
      await expect(page.locator('main h1')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
    }
  });
});
