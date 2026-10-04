import { config } from '../config.js';
import { submitQueuedTimestamps, upgradePendingTimestamps } from '../integrity/timestamping.js';
import { logger } from '../lib/logger.js';
import { runMaintenance } from './maintenance.js';
import { processAttachment } from './processAttachment.js';
import { QUEUES, startQueue } from './queue.js';

/** Register job handlers and schedules. Runs in the "worker" (or "all") role. */
export async function startWorker(): Promise<void> {
  const c = config();
  const boss = await startQueue({ supervise: true });

  await boss.work<{ attachmentId: string }>(
    QUEUES.processAttachment,
    { localConcurrency: c.OCR_CONCURRENCY, batchSize: 1 } as never,
    async (jobs) => {
      for (const job of jobs) await processAttachment(job.data.attachmentId);
    },
  );
  await boss.work(QUEUES.timestampSubmit, async () => {
    await submitQueuedTimestamps();
  });
  await boss.work(QUEUES.timestampUpgrade, async () => {
    await upgradePendingTimestamps();
  });
  await boss.work(QUEUES.maintenance, async () => {
    const stats = await runMaintenance();
    logger.info({ stats }, 'maintenance complete');
  });

  if (c.TIMESTAMP_PROVIDER !== 'none') {
    await boss.schedule(QUEUES.timestampSubmit, `*/${Math.min(c.OTS_BATCH_INTERVAL_MINUTES, 59)} * * * *`);
    await boss.schedule(QUEUES.timestampUpgrade, '17 * * * *');
  } else {
    await boss.unschedule(QUEUES.timestampSubmit).catch(() => undefined);
    await boss.unschedule(QUEUES.timestampUpgrade).catch(() => undefined);
  }
  await boss.schedule(QUEUES.maintenance, '41 * * * *');
  logger.info({ ocr: c.OCR_ENABLED, timestamps: c.TIMESTAMP_PROVIDER }, 'background worker started');
}
