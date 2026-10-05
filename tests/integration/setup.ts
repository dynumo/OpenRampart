import { afterAll } from 'vitest';
import { TEST_ENV } from './env.js';

Object.assign(process.env, TEST_ENV);

afterAll(async () => {
  const { stopQueue } = await import('../../src/server/jobs/queue.js');
  const { closeDb } = await import('../../src/server/db/client.js');
  await stopQueue().catch(() => undefined);
  await closeDb().catch(() => undefined);
});
