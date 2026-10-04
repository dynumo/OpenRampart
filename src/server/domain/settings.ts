import { eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { systemSettings } from '../db/schema.js';

/**
 * Runtime system settings editable by administrators. Environment variables
 * provide defaults; a stored value overrides them.
 */
export interface SystemSettings {
  registrationMode: 'first-user' | 'open' | 'closed';
}

export async function getSystemSettings(): Promise<SystemSettings> {
  const rows = await db().select().from(systemSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const mode = map.get('registrationMode');
  return {
    registrationMode:
      mode === 'open' || mode === 'closed' || mode === 'first-user' ? mode : config().REGISTRATION_MODE,
  };
}

export async function setSystemSetting<K extends keyof SystemSettings>(
  key: K,
  value: SystemSettings[K],
  userId: string,
): Promise<void> {
  await db()
    .insert(systemSettings)
    .values({ key, value: value as unknown as object, updatedBy: userId })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: value as unknown as object, updatedBy: userId, updatedAt: sql`now()` },
    });
}

export async function deleteSystemSetting(key: string): Promise<void> {
  await db().delete(systemSettings).where(eq(systemSettings.key, key));
}
