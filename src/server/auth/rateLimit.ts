import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';
import { getPool } from '../db/client.js';
import { RateLimitedError } from '../lib/errors.js';

/**
 * Authentication rate limiting and brute-force protection, stored in
 * PostgreSQL so limits hold across restarts and replicas without Redis.
 */
interface LimiterSpec {
  points: number;
  duration: number; // seconds
  blockDuration?: number; // seconds
}

const SPECS = {
  loginIp: { points: 30, duration: 15 * 60, blockDuration: 15 * 60 },
  loginAccount: { points: 10, duration: 60 * 60, blockDuration: 30 * 60 },
  mfa: { points: 6, duration: 15 * 60, blockDuration: 15 * 60 },
  register: { points: 10, duration: 60 * 60 },
  invitation: { points: 30, duration: 60 * 60 },
  passwordReset: { points: 5, duration: 60 * 60 },
  sensitive: { points: 10, duration: 15 * 60, blockDuration: 15 * 60 },
  oauthToken: { points: 120, duration: 60 },
} satisfies Record<string, LimiterSpec>;

export type LimiterName = keyof typeof SPECS;

const limiters = new Map<LimiterName, RateLimiterPostgres>();

function limiter(name: LimiterName): RateLimiterPostgres {
  let l = limiters.get(name);
  if (!l) {
    const spec: LimiterSpec = SPECS[name];
    l = new RateLimiterPostgres({
      storeClient: getPool(),
      tableName: 'rate_limits',
      tableCreated: true,
      keyPrefix: `or_${name}`,
      points: spec.points,
      duration: spec.duration,
      blockDuration: spec.blockDuration ?? 0,
      clearExpiredByTimeout: true,
    });
    limiters.set(name, l);
  }
  return l;
}

/** Consume one point; throws RateLimitedError when exhausted. */
export async function hit(name: LimiterName, key: string): Promise<void> {
  if (process.env.OPENRAMPART_DISABLE_RATE_LIMITS === 'true') return;
  try {
    await limiter(name).consume(key.toLowerCase(), 1);
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      throw new RateLimitedError(Math.max(1, Math.ceil(err.msBeforeNext / 1000)));
    }
    throw err;
  }
}

/** Check without consuming. */
export async function assertNotBlocked(name: LimiterName, key: string): Promise<void> {
  if (process.env.OPENRAMPART_DISABLE_RATE_LIMITS === 'true') return;
  const res = await limiter(name).get(key.toLowerCase());
  if (res && res.remainingPoints <= 0 && res.msBeforeNext > 0) {
    throw new RateLimitedError(Math.ceil(res.msBeforeNext / 1000));
  }
}

export async function reset(name: LimiterName, key: string): Promise<void> {
  await limiter(name).delete(key.toLowerCase());
}
