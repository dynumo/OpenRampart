import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, ConfigError, loadConfig } from '../../src/server/config';

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const example = parseEnvFile(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'));
const secrets = {
  SESSION_SECRET: 'x'.repeat(48),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('.env.example', () => {
  it('documents every configuration setting', () => {
    const missing = CONFIG_KEYS.filter((k) => !(k in example));
    expect(missing).toEqual([]);
  });

  it('only contains settings the application or Compose file reads', () => {
    const composeOnly = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'];
    const unknown = Object.keys(example).filter(
      (k) => !CONFIG_KEYS.includes(k) && !composeOnly.includes(k),
    );
    expect(unknown).toEqual([]);
  });

  it('validates once the required secrets are filled in', () => {
    const c = loadConfig({ ...example, ...secrets });
    expect(c.mcpResourceUrl).toBe('https://rampart.example.org/mcp');
    expect(c.cookieSecure).toBe(true);
  });
});

describe('configuration validation', () => {
  it('lists every problem at once', () => {
    try {
      loadConfig({ APP_URL: 'not a url' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      for (const key of [
        'APP_URL',
        'DATABASE_URL',
        'SESSION_SECRET',
        'ENCRYPTION_KEY',
        'S3_BUCKET',
      ])
        expect(msg).toContain(key);
    }
  });

  it('refuses plain http and the log mail provider in production', () => {
    expect(() =>
      loadConfig({ ...example, ...secrets, APP_URL: 'http://rampart.example.org' }),
    ).toThrow(/https/);
    expect(() => loadConfig({ ...example, ...secrets, MAIL_PROVIDER: 'log' })).toThrow(
      /development only/,
    );
    expect(() =>
      loadConfig({ ...example, ...secrets, NODE_ENV: 'development', MAIL_PROVIDER: 'log' }),
    ).not.toThrow();
  });

  it('requires provider credentials for the chosen mail provider', () => {
    expect(() =>
      loadConfig({
        ...example,
        ...secrets,
        MAIL_PROVIDER: 'elasticemail',
        MAIL_FROM_ADDRESS: 'a@b.c',
      }),
    ).toThrow(/ELASTIC_EMAIL_API_KEY/);
    expect(() => loadConfig({ ...example, ...secrets, MAIL_PROVIDER: 'smtp' })).toThrow(
      /SMTP_HOST/,
    );
  });
});
