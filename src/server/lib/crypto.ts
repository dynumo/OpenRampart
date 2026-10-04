import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

/**
 * Thin wrappers around Node's standard crypto primitives. OpenRampart does not
 * implement any cryptographic algorithm itself.
 */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Keyed hash used to store bearer secrets (session, invitation, reset tokens). */
export function tokenHash(token: string, purpose: string): string {
  return createHmac('sha256', config().SESSION_SECRET).update(`${purpose}:${token}`).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Authenticated encryption (AES-256-GCM) for secrets that must be recoverable,
 * such as TOTP shared secrets and the OAuth signing key set.
 * Format: v1.<iv>.<tag>.<ciphertext>, each part base64url.
 */
export function encryptSecret(plaintext: string, key: Buffer = config().encryptionKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(value: string, key: Buffer = config().encryptionKey): string {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) {
    throw new Error('Unrecognised encrypted secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
