import path from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible, newSignedInContext, register } from './helpers';

const fixtures = path.resolve('tests/fixtures/documents');
const letter = path.join(fixtures, 'letter.png');
const scanned = path.join(fixtures, 'scanned-letter.pdf');

test('phone letter capture with several pages, OCR and OCR search', async ({ page, browser }) => {
  const account = await register(page);
  const { context, page: phone } = await newSignedInContext(browser, account, true);
  await phone.getByRole('navigation', { name: 'Main (mobile)' }).getByRole('link', { name: 'Add Event' }).click();
  await phone.getByRole('link', { name: 'Photograph a letter' }).click();
  await expect(phone.getByRole('heading', { name: 'Capture a letter' })).toBeVisible();
  await expectAccessible(phone, 'capture (empty)');
  // The camera input (capture="environment") opens the camera on phones; here we supply files.
  await phone.locator('input[type=file][capture]').setInputFiles([letter]);
  await phone.locator('input[type=file]:not([capture])').setInputFiles([letter, scanned]);
  await expect(phone.getByRole('list', { name: 'Pages in order' }).getByRole('listitem')).toHaveCount(3);
  // Reorder without drag and drop.
  await phone.getByRole('button', { name: 'Move page 3 earlier' }).click();
  await expect(phone.getByText('Page moved to position 2.')).toBeVisible();
  await phone.getByRole('button', { name: 'Remove page 3' }).click();
  await expect(phone.getByRole('list', { name: 'Pages in order' }).getByRole('listitem')).toHaveCount(2);
  await phone.getByLabel('Who is it from?').fill('HM Revenue and Customs');
  await phone.getByRole('button', { name: /Create new Actor/ }).click();
  await expectAccessible(phone, 'capture (with pages)');
  await phone.getByRole('button', { name: 'Save letter (2 pages)' }).click();
  await expect(phone.getByText('Letter saved')).toBeVisible({ timeout: 30_000 });
  await expect(phone.getByRole('heading', { name: 'Attachments (2)' })).toBeVisible();

  // OCR completes asynchronously; the attachment page shows the recognised text.
  await phone.getByRole('link', { name: /attachment 1/ }).click();
  await expect(phone.getByRole('region', { name: 'Recognised text' })).toContainText('penguinword', { timeout: 60_000 });
  await expect(phone.getByText(/Original unchanged/)).toBeVisible({ timeout: 30_000 });
  await expectAccessible(phone, 'document viewer');
  await expect(phone.getByRole('heading', { name: 'Found in the document' })).toBeVisible();

  // OCR text is searchable.
  await page.goto('/search?q=penguinword');
  await expect(page.getByRole('heading', { name: /Documents \(/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('mark').first()).toHaveText(/penguinword/i);
  await context.close();
});
