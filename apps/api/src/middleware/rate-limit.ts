import type { APIGatewayProxyEvent } from 'aws-lambda';
import { getRedisClient, CacheKeys, CacheTTL } from '../lib/redis';

/**
 * Sliding window rate limiter using Redis.
 *
 * Interview talking point: "I use a sliding window counter instead of
 * a fixed window to avoid the burst problem at window boundaries.
 * A fixed window allows 2x the limit if requests straddle the reset."
 *
 * Algorithm:
 * 1. Remove timestamps older than the window
 * 2. Count remaining entries
 * 3. If under limit, add current timestamp and allow
 * 4. If over limit, reject with 429
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const redis = getRedisClient();
  const now = Date.now();
  const windowStart = now - windowMs;

  // Lua script for atomic sliding window — no race conditions
  const luaScript = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window_start = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local window_ms = tonumber(ARGV[4])

    -- Remove expired entries
    redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

    -- Count current entries
    local count = redis.call('ZCARD', key)

    if count < limit then
      -- Add this request
      redis.call('ZADD', key, now, now .. '-' .. math.random(1000000))
      redis.call('PEXPIRE', key, window_ms)
      return {1, limit - count - 1}
    else
      return {0, 0}
    end
  `;

  const result = await redis.eval(
    luaScript,
    1,
    key,
    now.toString(),
    windowStart.toString(),
    limit.toString(),
    windowMs.toString()
  ) as [number, number];

  return {
    allowed: result[0] === 1,
    remaining: result[1] ?? 0,
    resetAt: Math.floor((now + windowMs) / 1000),
    limit,
  };
}

/**
 * Extract the real client IP, accounting for API Gateway and CloudFront headers.
 */
export function getClientIp(event: APIGatewayProxyEvent): string {
  return (
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ??
    event.headers['cf-connecting-ip'] ??
    event.requestContext.identity?.sourceIp ??
    'unknown'
  );
}

/**
 * Rate limit configs per endpoint type.
 */
export const RateLimits = {
  // Shorten: anonymous users get 10/min, authenticated get 100/min
  shorten: {
    anonymous: { limit: 10, windowMs: 60_000 },
    authenticated: { limit: 100, windowMs: 60_000 },
  },
  // Redirect: 300/min per IP (DDoS protection without breaking real users)
  redirect: { limit: 300, windowMs: 60_000 },
} as const;