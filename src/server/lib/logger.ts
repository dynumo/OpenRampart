import pino from 'pino';

/**
 * Structured logger. Redaction rules guarantee that credentials, attachment
 * contents and OCR text never reach routine logs. Code should log identifiers,
 * not content.
 */
const REDACT = [
  'password',
  '*.password',
  'newPassword',
  '*.newPassword',
  'currentPassword',
  '*.currentPassword',
  'token',
  '*.token',
  'code',
  '*.code',
  'secret',
  '*.secret',
  'ocrText',
  '*.ocrText',
  'ocr_text',
  '*.ocr_text',
  'description',
  '*.description',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'openrampart' },
});

export type Logger = typeof logger;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request path that is safe to log: no query string, and no one-time tokens
 * (invitation and password-reset links, OAuth interaction ids). Record ids are
 * UUIDs and are kept, because they identify rows without revealing content.
 */
function isTokenLike(segment: string): boolean {
  // Random tokens are long and mix cases or digits; route names are lower-case words.
  return (
    segment.length >= 16 &&
    !UUID.test(segment) &&
    /^[A-Za-z0-9_-]+$/.test(segment) &&
    /[0-9A-Z]/.test(segment)
  );
}

export function loggablePath(url: string): string {
  const path = String(url).split('?')[0]!;
  return path
    .split('/')
    .map((segment) => (isTokenLike(segment) ? ':token' : segment))
    .join('/');
}
