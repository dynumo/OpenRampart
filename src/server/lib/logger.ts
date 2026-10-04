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
