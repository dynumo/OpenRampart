import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { requestRateLimit } from '../../src/server/http/middleware.js';
import { RateLimitedError } from '../../src/server/lib/errors.js';

describe('requestRateLimit', () => {
  it('allows normal traffic and rejects a flood from one address', async () => {
    const previous = process.env.OPENRAMPART_DISABLE_RATE_LIMITS;
    delete process.env.OPENRAMPART_DISABLE_RATE_LIMITS;
    try {
      const req = { ip: '203.0.113.9' } as Request;
      const results: unknown[] = [];
      const next: NextFunction = (err?: unknown) => {
        results.push(err);
      };
      for (let i = 0; i < 601; i++) await requestRateLimit(req, {} as Response, next);
      expect(results.slice(0, 600).every((r) => r === undefined)).toBe(true);
      expect(results[600]).toBeInstanceOf(RateLimitedError);

      // Another address is unaffected.
      const other: unknown[] = [];
      await requestRateLimit({ ip: '203.0.113.10' } as Request, {} as Response, (err?: unknown) => {
        other.push(err);
      });
      expect(other).toEqual([undefined]);
    } finally {
      if (previous !== undefined) process.env.OPENRAMPART_DISABLE_RATE_LIMITS = previous;
    }
  });
});
