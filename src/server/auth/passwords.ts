import argon2 from 'argon2';
import { ValidationError } from '../lib/errors.js';

/**
 * Password hashing with Argon2id using the OWASP-recommended baseline
 * (19 MiB memory, 2 iterations, 1 degree of parallelism).
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, OPTIONS);
}

let dummyHash: Promise<string> | undefined;
/**
 * Perform an equivalent amount of work when the account does not exist, so
 * response timing does not reveal whether a username is registered.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('openrampart-timing-equaliser');
  await verifyPassword(await dummyHash, password);
}

const COMMON = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiopas',
  'iloveyou1234',
  'letmeinletmein',
  'administrator',
  'openrampart1',
  'openrampart123',
]);

export function validatePassword(
  password: string,
  context: { username?: string; email?: string | null } = {},
): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`, {
      password: `Use at least ${PASSWORD_MIN_LENGTH} characters. A short phrase of several words works well.`,
    });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError('Password is too long', {
      password: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
    });
  }
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) {
    throw new ValidationError('Password is too easy to guess', {
      password: 'This password is too common. Choose something less predictable.',
    });
  }
  if (context.username && lower.includes(context.username.toLowerCase())) {
    throw new ValidationError('Password must not contain your username', {
      password: 'Your password must not contain your username.',
    });
  }
}
