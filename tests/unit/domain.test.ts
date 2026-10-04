import { describe, expect, it } from 'vitest';
import { formatOccurrence, localDateString, parseOccurrence, zonedToUtc } from '../../src/shared/dates.js';
import { expandScopes } from '../../src/shared/scopes.js';
import { canonicalHash, canonicalJson } from '../../src/server/integrity/canonical.js';
import { buildSuggestions, extractAmounts, extractDates, extractReferences } from '../../src/server/ocr/suggestions.js';
import { loadConfig, ConfigError } from '../../src/server/config.js';
import { sanitiseFilename, isInlineSafe } from '../../src/server/storage/fileTypes.js';
import { validatePassword } from '../../src/server/auth/passwords.js';
import { normaliseRecoveryCode } from '../../src/server/auth/recoveryCodes.js';

describe('date handling', () => {
  it('interprets date-only and local times in the record owner’s time zone, across DST', () => {
    expect(parseOccurrence('2026-07-01', 'Europe/London')).toEqual({ instant: new Date('2026-06-30T23:00:00Z'), precision: 'date' });
    expect(parseOccurrence('2026-01-01', 'Europe/London')!.instant.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(parseOccurrence('2026-03-29T01:30', 'Europe/London')!.instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(parseOccurrence('2026-07-01T09:00', 'America/New_York')!.instant.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(parseOccurrence('2026-07-01T09:00:00+01:00', 'Asia/Tokyo')!.instant.toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(parseOccurrence('2026-02-30', 'Europe/London')).toBeNull();
    expect(parseOccurrence('yesterday', 'Europe/London')).toBeNull();
  });

  it('round-trips local dates and formats in British English', () => {
    const instant = zonedToUtc(2026, 9, 12, 0, 0, 0, 'Europe/London');
    expect(localDateString(instant, 'Europe/London')).toBe('2026-09-12');
    expect(formatOccurrence(instant, 'date', 'Europe/London')).toBe('12 September 2026');
  });
});

describe('canonical revision hashing (RFC 8785)', () => {
  it('is independent of key order and stable', () => {
    const a = canonicalHash({ b: 2, a: [1, { d: 'x', c: null }] });
    const b = canonicalHash({ a: [1, { c: null, d: 'x' }], b: 2 });
    expect(a).toEqual(b);
    expect(canonicalJson({ b: 1, a: 'é' })).toBe('{"a":"é","b":1}');
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('document suggestions', () => {
  const letter = `HM Revenue & Customs
Our reference: UTR 1234567890
Date: 3rd October 2026
Re: Self Assessment penalty
You owe £1,100.00. A previous payment of £250 was received on 12/09/2026.`;

  it('extracts dates (UK day-first), amounts and references', () => {
    expect(extractDates(letter).map((d) => d.value)).toEqual(['2026-10-03', '2026-09-12']);
    expect(extractAmounts(letter)).toEqual([
      { value: '1100.00', currency: 'GBP', text: '£1,100.00' },
      { value: '250', currency: 'GBP', text: '£250' },
    ]);
    expect(extractReferences(letter)[0]).toMatchObject({ value: 'UTR 1234567890' });
  });

  it('matches known Actors by name or alias and proposes a title', () => {
    const s = buildSuggestions(letter, [{ id: 'a1', name: 'HMRC', aliases: ['HM Revenue & Customs'] }]);
    expect(s.actors[0]).toMatchObject({ actorId: 'a1', name: 'HMRC' });
    expect(s.title).toBe('Self Assessment penalty');
  });
});

describe('configuration validation', () => {
  const base = {
    APP_URL: 'https://record.example.org',
    DATABASE_URL: 'postgres://u:p@db/openrampart',
    SESSION_SECRET: 'x'.repeat(40),
    ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    S3_BUCKET: 'b',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
  };
  it('derives OAuth issuer and MCP resource from APP_URL', () => {
    const c = loadConfig(base);
    expect(c.oauthIssuer).toBe('https://record.example.org');
    expect(c.mcpResourceUrl).toBe('https://record.example.org/mcp');
    expect(c.cookieSecure).toBe(true);
  });
  it('lists every missing or invalid setting at once', () => {
    try {
      loadConfig({ ...base, DATABASE_URL: '', SESSION_SECRET: 'short', MAIL_PROVIDER: 'elasticemail' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('SESSION_SECRET');
      expect(msg).toContain('ELASTIC_EMAIL_API_KEY');
      expect(msg).toContain('MAIL_FROM_ADDRESS');
    }
  });
  it('refuses plain http in production except for localhost', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', APP_URL: 'http://record.example.org' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', APP_URL: 'http://localhost:3000' })).not.toThrow();
  });
});

describe('file and credential safety', () => {
  it('sanitises uploaded filenames', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFilename('C:\\Users\\x\\letter.pdf')).toBe('letter.pdf');
    expect(sanitiseFilename('..hidden')).toBe('hidden');
    expect(sanitiseFilename('bad\u0000name<>.txt')).toBe('badname.txt');
    expect(sanitiseFilename('')).toBe('upload');
    expect(sanitiseFilename('a'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(200);
  });
  it('only renders passive types inline', () => {
    expect(isInlineSafe('image/png')).toBe(true);
    expect(isInlineSafe('application/pdf')).toBe(true);
    expect(isInlineSafe('text/html')).toBe(false);
    expect(isInlineSafe('image/svg+xml')).toBe(false);
  });
  it('enforces password rules', () => {
    expect(() => validatePassword('short')).toThrow();
    expect(() => validatePassword('passwordpassword')).toThrow();
    expect(() => validatePassword('my username is alice123', { username: 'alice123' })).toThrow();
    expect(() => validatePassword('three random words here')).not.toThrow();
  });
  it('normalises recovery codes', () => {
    expect(normaliseRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
  });
  it('expands scope hierarchies', () => {
    expect([...expandScopes(['attachments:read', 'bogus'])].sort()).toEqual(['attachments:metadata', 'attachments:read']);
  });
});
