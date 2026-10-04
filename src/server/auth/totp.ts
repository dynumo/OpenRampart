import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30-second period — the settings every
 * mainstream authenticator app supports), implemented by otplib.
 */
export const TOTP_ISSUER = 'OpenRampart';

export function newTotpSecret(): string {
  // 20 bytes (160 bits) as recommended by RFC 4226.
  return generateSecret({ length: 20 });
}

export function totpUri(secret: string, accountLabel: string, issuer = TOTP_ISSUER): string {
  return generateURI({ issuer, label: accountLabel, secret });
}

export async function totpQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
}

/** Group a base32 secret into blocks of four for manual entry. */
export function formatSecretForDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export interface TotpCheck {
  valid: boolean;
  timeStep?: number;
}

/**
 * Verify a code, allowing one period of clock drift either side and refusing
 * any time step at or before `lastStep` (replay protection).
 */
export async function checkTotp(secret: string, token: string, lastStep?: number | null): Promise<TotpCheck> {
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { valid: false };
  const result = await verify({
    secret,
    token: cleaned,
    epochTolerance: 30,
    ...(lastStep != null ? { afterTimeStep: lastStep } : {}),
  });
  if (!result.valid) return { valid: false };
  return { valid: true, timeStep: (result as { timeStep?: number }).timeStep };
}
