import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production build with a dedicated
 * database and bucket. Prerequisites: PostgreSQL and S3-compatible storage
 * (see docker-compose.dev.yml) and `npm run build`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE = `http://localhost:${PORT}`;

export const E2E_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  APP_URL: E2E_BASE,
  PORT: String(PORT),
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://openrampart:openrampart@localhost:5432/openrampart_e2e',
  SESSION_SECRET: 'e2e-session-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  S3_ENDPOINT: process.env.E2E_S3_ENDPOINT ?? 'http://localhost:8333',
  S3_BUCKET: process.env.E2E_S3_BUCKET ?? 'openrampart-e2e',
  S3_ACCESS_KEY_ID: process.env.E2E_S3_ACCESS_KEY_ID ?? 'openrampart',
  S3_SECRET_ACCESS_KEY: process.env.E2E_S3_SECRET_ACCESS_KEY ?? 'openrampart-dev-secret',
  S3_FORCE_PATH_STYLE: 'true',
  S3_CREATE_BUCKET: 'true',
  MAIL_PROVIDER: 'log',
  MAIL_FROM_ADDRESS: 'e2e@openrampart.invalid',
  REGISTRATION_MODE: 'open',
  OPENRAMPART_DISABLE_RATE_LIMITS: 'true',
  LOG_LEVEL: 'warn',
};

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: E2E_BASE,
    trace: 'retain-on-failure',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) } },
  ],
  webServer: {
    command: 'node scripts/e2e-reset-db.mjs && node dist/server/index.js',
    url: `${E2E_BASE}/healthz`,
    env: E2E_ENV,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
  },
});
