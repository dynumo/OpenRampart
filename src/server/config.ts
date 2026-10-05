import { z } from 'zod';

/**
 * Central configuration. Every setting comes from environment variables so the
 * application can be deployed with Docker / Dokploy without editing files.
 *
 * `loadConfig()` validates the environment and throws a single readable error
 * listing every problem, so a misconfigured deployment fails fast at startup.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `expected true/false, got "${v}"` });
      return z.NEVER;
    });

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `expected an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const url = (description: string) =>
  z
    .string({ error: `${description} is required` })
    .trim()
    .min(1, `${description} is required`)
    .refine((v) => URL.canParse(v), `${description} must be an absolute URL`)
    .transform((v) => v.replace(/\/+$/, ''));

const list = (def: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const envObject = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  OPENRAMPART_ROLE: z.enum(['all', 'web', 'worker']).default('all'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  APP_URL: url('APP_URL'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3000, 1, 65535),
  TRUST_PROXY: z.string().default('1'),

  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required')
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgres:// URL'),
  DATABASE_SSL: z.enum(['disable', 'require', 'no-verify']).default('disable'),
  DATABASE_POOL_MAX: int(10, 1, 200),

  SESSION_SECRET: z
    .string({ error: 'SESSION_SECRET is required' })
    .min(
      32,
      'SESSION_SECRET must be at least 32 characters (generate with: openssl rand -base64 48)',
    ),
  ENCRYPTION_KEY: z.string({ error: 'ENCRYPTION_KEY is required' }).refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'ENCRYPTION_KEY must be 32 bytes encoded as base64 (generate with: openssl rand -base64 32)'),
  SESSION_MAX_AGE_HOURS: int(24 * 14, 1, 24 * 365),
  SESSION_IDLE_TIMEOUT_MINUTES: int(60 * 24 * 3, 5, 60 * 24 * 365),
  REQUIRE_TOTP: bool(true),
  REGISTRATION_MODE: z.enum(['first-user', 'open', 'closed']).default('first-user'),
  COOKIE_SECURE: optionalString,

  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string({ error: 'S3_BUCKET is required' }).min(1, 'S3_BUCKET is required'),
  S3_ACCESS_KEY_ID: z
    .string({ error: 'S3_ACCESS_KEY_ID is required' })
    .min(1, 'S3_ACCESS_KEY_ID is required'),
  S3_SECRET_ACCESS_KEY: z
    .string({ error: 'S3_SECRET_ACCESS_KEY is required' })
    .min(1, 'S3_SECRET_ACCESS_KEY is required'),
  S3_FORCE_PATH_STYLE: bool(false),
  S3_CREATE_BUCKET: bool(false),
  S3_KEY_PREFIX: z.string().default(''),

  MAX_UPLOAD_MB: int(50, 1, 2048),
  DELETION_RETENTION_DAYS: int(30, 0, 3650),

  OCR_ENABLED: bool(true),
  OCR_LANGUAGES: z
    .string()
    .default('eng')
    .refine(
      (v) => /^[a-z_]+(\+[a-z_]+)*$/i.test(v),
      'OCR_LANGUAGES must look like "eng" or "eng+cym"',
    ),
  OCR_TIMEOUT_SECONDS: int(300, 10, 3600),
  OCR_CONCURRENCY: int(1, 1, 16),
  OCR_MAX_PDF_PAGES: int(200, 1, 5000),

  TIMESTAMP_PROVIDER: z.enum(['none', 'opentimestamps']).default('none'),
  OTS_CALENDARS: list([
    'https://a.pool.opentimestamps.org',
    'https://b.pool.opentimestamps.org',
    'https://a.pool.eternitywall.com',
  ]),
  OTS_MIN_CALENDARS: int(1, 1, 10),
  OTS_BATCH_INTERVAL_MINUTES: int(10, 1, 1440),
  OTS_UPGRADE_INTERVAL_MINUTES: int(180, 5, 10080),
  BITCOIN_EXPLORER_URL: z.string().default('https://blockstream.info/api'),

  OAUTH_ISSUER: optionalString,
  MCP_RESOURCE_URL: optionalString,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: int(3600, 60, 86400),
  OAUTH_REFRESH_TOKEN_TTL_DAYS: int(30, 1, 365),
  OAUTH_ENABLE_DCR: bool(true),
  OAUTH_ENABLE_CIMD: bool(true),

  MAIL_PROVIDER: z.enum(['none', 'log', 'elasticemail', 'smtp']).default('none'),
  MAIL_FROM_ADDRESS: optionalString,
  MAIL_FROM_NAME: z.string().default('OpenRampart'),
  ELASTIC_EMAIL_API_KEY: optionalString,
  ELASTIC_EMAIL_API_URL: z.string().default('https://api.elasticemail.com/v4'),
  SMTP_HOST: optionalString,
  SMTP_PORT: int(587, 1, 65535),
  SMTP_SECURE: bool(false),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,

  INVITATION_TTL_HOURS: int(72, 1, 24 * 30),
});

/** Every environment variable OpenRampart reads through the configuration schema. */
export const CONFIG_KEYS = Object.keys(envObject.shape);

const envSchema = envObject.superRefine((env, ctx) => {
  if (env.MAIL_PROVIDER === 'elasticemail' && !env.ELASTIC_EMAIL_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['ELASTIC_EMAIL_API_KEY'],
      message: 'ELASTIC_EMAIL_API_KEY is required when MAIL_PROVIDER=elasticemail',
    });
  }
  if (env.MAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_HOST'],
      message: 'SMTP_HOST is required when MAIL_PROVIDER=smtp',
    });
  }
  if (['elasticemail', 'smtp'].includes(env.MAIL_PROVIDER) && !env.MAIL_FROM_ADDRESS) {
    ctx.addIssue({
      code: 'custom',
      path: ['MAIL_FROM_ADDRESS'],
      message: 'MAIL_FROM_ADDRESS is required when a mail provider is configured',
    });
  }
  if (env.NODE_ENV === 'production' && env.MAIL_PROVIDER === 'log') {
    ctx.addIssue({
      code: 'custom',
      path: ['MAIL_PROVIDER'],
      message:
        'MAIL_PROVIDER=log prints messages (including reset links) to the log and is for development only; use elasticemail, smtp or none',
    });
  }
  if (env.NODE_ENV === 'production' && env.APP_URL.startsWith('http://')) {
    const host = new URL(env.APP_URL).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'APP_URL must use https:// in production (OAuth and secure cookies depend on it)',
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

export interface Config extends Env {
  appUrl: URL;
  cookieSecure: boolean;
  oauthIssuer: string;
  mcpResourceUrl: string;
  maxUploadBytes: number;
  encryptionKey: Buffer;
  trustProxy: boolean | number | string;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `OpenRampart configuration is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'See .env.example and docs/configuration.md for every setting.',
    );
    this.name = 'ConfigError';
  }
}

function parseTrustProxy(v: string): boolean | number | string {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(environment)';
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  const env = result.data;
  const appUrl = new URL(env.APP_URL);
  const oauthIssuer = (env.OAUTH_ISSUER ?? env.APP_URL).replace(/\/+$/, '');
  const mcpResourceUrl = (env.MCP_RESOURCE_URL ?? `${env.APP_URL}/mcp`).replace(/\/+$/, '');
  const cookieSecure =
    env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : appUrl.protocol === 'https:';
  return {
    ...env,
    appUrl,
    cookieSecure,
    oauthIssuer,
    mcpResourceUrl,
    maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'base64'),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}

let cached: Config | undefined;

export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: replace the active configuration. */
export function setConfig(next: Config): void {
  cached = next;
}
