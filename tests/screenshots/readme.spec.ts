import { expect, test, type Page } from '@playwright/test';
import { apiCall, register } from '../e2e/helpers';

// Every name and detail here is made up for illustration.
const OUT = 'docs/images';

async function seed(page: Page) {
  const actor = (name: string, kind: 'organisation' | 'person' = 'organisation') =>
    apiCall<{ id: string }>(page, 'POST', '/actors', { name, kind });
  const housing = await actor('Fernley Housing Association');
  const council = await actor('Westmoor Borough Council');
  const energy = await actor('Brightwater Energy');
  const advocate = await actor('Sam Taylor (advocate)', 'person');

  const event = (body: Record<string, unknown>) =>
    apiCall<{ id: string }>(page, 'POST', '/events', body);
  const ids: string[] = [];
  ids.push(
    (
      await event({
        typeId: 'phone_call',
        title: 'Reported damp in the bedroom',
        occurredAt: '2026-06-03',
        direction: 'outbound',
        description:
          'Rang the repairs line. Told someone would call back within 5 working days. Reference given over the phone.',
        reference: 'REP-48213',
        actors: [{ actorId: housing.id }],
      })
    ).id,
  );
  ids.push(
    (
      await event({
        typeId: 'letter_in',
        title: 'Repair appointment letter',
        occurredAt: '2026-06-17',
        direction: 'inbound',
        description: 'Inspection booked for 2 July, morning slot.',
        reference: 'REP-48213',
        actors: [{ actorId: housing.id }],
      })
    ).id,
  );
  ids.push(
    (
      await event({
        typeId: 'observation',
        title: 'Inspector did not arrive',
        occurredAt: '2026-07-02',
        description: 'Waited in from 8am to 1pm. No call or message.',
        riskLevel: 'medium',
        actors: [{ actorId: housing.id }],
      })
    ).id,
  );
  ids.push(
    (
      await event({
        typeId: 'email_out',
        title: 'Formal complaint about missed inspection',
        occurredAt: '2026-07-04',
        direction: 'outbound',
        description: 'Stage 1 complaint sent to the complaints team, with photos of the mould.',
        dueOn: '2026-07-18',
        actors: [{ actorId: housing.id }, { actorId: advocate.id }],
      })
    ).id,
  );
  ids.push(
    (
      await event({
        typeId: 'advice',
        title: 'Advice on the complaints process',
        occurredAt: '2026-07-08',
        description: 'Sam suggested keeping a daily note of the damp and any health effects.',
        actors: [{ actorId: advocate.id }],
      })
    ).id,
  );
  ids.push(
    (
      await event({
        typeId: 'decision',
        title: 'Complaint upheld at stage 1',
        occurredAt: '2026-07-22',
        direction: 'inbound',
        description: 'Apology, repair booked for 5 August and 150 pounds compensation.',
        amount: '150.00',
        currency: 'GBP',
        actors: [{ actorId: housing.id }],
      })
    ).id,
  );
  await event({
    typeId: 'payment',
    title: 'Council Tax instalment paid',
    occurredAt: '2026-08-01',
    direction: 'outbound',
    amount: '142.50',
    currency: 'GBP',
    reference: 'CT-0093317',
    actors: [{ actorId: council.id }],
  });
  await event({
    typeId: 'portal',
    title: 'Meter reading submitted',
    occurredAt: '2026-08-14',
    direction: 'outbound',
    description: 'Reading 04821 submitted through the online account.',
    actors: [{ actorId: energy.id }],
  });
  await event({
    typeId: 'letter_in',
    title: 'Revised payment plan offered',
    occurredAt: '2026-09-09',
    direction: 'inbound',
    riskLevel: 'low',
    dueOn: '2026-09-30',
    actors: [{ actorId: energy.id }],
  });
  const incident = await apiCall<{ id: string }>(page, 'POST', '/incidents', {
    title: 'Bedroom damp and mould 2026',
    status: 'open',
    openedOn: '2026-06-03',
    description: 'Damp reported in June; inspection missed; complaint upheld; repair pending.',
    eventIds: ids,
  });
  return { decisionId: ids[5]!, incidentId: incident.id };
}

async function shoot(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

test('README screenshots', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const account = await register(page, 'Alex Example');
  const { decisionId, incidentId } = await seed(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await shoot(page, `timeline-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`/events/${decisionId}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Complaint upheld at stage 1' }),
  ).toBeVisible();
  await shoot(page, 'event-light');
  await page.goto(`/incidents/${incidentId}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Bedroom damp and mould 2026' }),
  ).toBeVisible();
  await shoot(page, 'incident-light');

  // Phone-sized view, reusing this browser session's cookies.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    storageState: await page.context().storageState(),
  });
  const phone = await mobile.newPage();
  await phone.goto('/');
  await expect(phone.getByRole('heading', { name: 'Timeline' })).toBeVisible();
  await shoot(phone, 'timeline-mobile-dark');
  await mobile.close();
  void account;
});
