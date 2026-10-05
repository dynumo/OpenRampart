import { randomInt } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { recoveryCodes } from '../db/schema.js';
import { tokenHash } from '../lib/crypto.js';

/**
 * Single-use account recovery codes. Each code carries 50 bits of entropy
 * from a CSPRNG and is stored only as a keyed HMAC; the plaintext is shown to
 * the user once and never stored.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const RECOVERY_CODE_COUNT = 10;

function generateCode(): string {
  let raw = '';
  for (let i = 0; i < 10; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function normaliseRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hmacCode(code: string): string {
  return tokenHash(normaliseRecoveryCode(code), 'recovery-code');
}

export function looksLikeRecoveryCode(input: string): boolean {
  return normaliseRecoveryCode(input).length === 10 && !/^\d+$/.test(normaliseRecoveryCode(input));
}

/** Replace all of a user's recovery codes. Returns the new plaintext codes. */
export async function regenerateRecoveryCodes(
  userId: string,
  executor: Executor = db(),
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateCode);
  await executor.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await executor
    .insert(recoveryCodes)
    .values(codes.map((c) => ({ userId, codeHmac: hmacCode(c) })));
  return codes;
}

/** Atomically consume a code. Returns true only the first time a valid code is used. */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const rows = await db()
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHmac, hmacCode(code)),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id });
  return rows.length === 1;
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  const rows = await db()
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return rows.length;
}
