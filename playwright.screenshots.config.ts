import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Regenerates the README screenshots in docs/images from made-up data:
 *   npm run build && npm run screenshots
 * Needs the same PostgreSQL and S3 services as the end-to-end tests.
 */
export default defineConfig({
  ...base,
  testDir: 'tests/screenshots',
  retries: 0,
  reporter: 'list',
});
