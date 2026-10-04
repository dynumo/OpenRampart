import { PgBoss } from 'pg-boss';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Background jobs run on pg-boss, a PostgreSQL-backed queue: no Redis or other
 * broker is needed. pg-boss keeps its own tables in the `pgboss` schema.
 */
export const QUEUES = {
  processAttachment: 'attachment-process',
  verifyAttachment: 'attachment-verify',
  timestampSubmit: 'timestamp-submit',
  timestampUpgrade: 'timestamp-upgrade',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

export async function startQueue(opts: { supervise: boolean }): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const c = config();
    const b = new PgBoss({
      connectionString: c.DATABASE_URL,
      ssl:
        c.DATABASE_SSL === 'disable'
          ? undefined
          : { rejectUnauthorized: c.DATABASE_SSL === 'require' },
      max: 4,
      schema: 'pgboss',
      supervise: opts.supervise,
      schedule: opts.supervise,
      application_name: 'openrampart-jobs',
    } as ConstructorParameters<typeof PgBoss>[0]);
    b.on('error', (err: Error) => logger.error({ err: err.message }, 'job queue error'));
    await b.start();
    for (const name of Object.values(QUEUES)) {
      await b.createQueue(name, {
        retryLimit: name === QUEUES.processAttachment ? 3 : 5,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: name === QUEUES.processAttachment ? c.OCR_TIMEOUT_SECONDS * 4 : 900,
      } as never);
    }
    boss = b;
    return b;
  })();
  return starting;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 20_000 } as never);
    boss = undefined;
    starting = undefined;
  }
}

export function queue(): PgBoss {
  if (!boss) throw new Error('Job queue not started');
  return boss;
}

export async function enqueue(name: QueueName, data: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const b = boss ?? (await startQueue({ supervise: false }));
  return b.send(name, data, options as never);
}
