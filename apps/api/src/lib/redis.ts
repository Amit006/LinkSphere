import Redis from 'ioredis';

/**
 * Redis client singleton.
 *
 * In Lambda, the execution context is reused between warm invocations.
 * We keep the connection alive on the module level so we don't reconnect
 * on every request.
 *
 * Interview talking point: "Lambda reuses the execution environment for warm
 * starts. By initializing Redis outside the handler, I avoid a new TCP
 * handshake on every invocation — critical for a redirect that needs <20ms."
 */

let redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (redis && redis.status === 'ready') {
    return redis;
  }

  redis = new Redis(process.env['REDIS_URL']!, {
    maxRetriesPerRequest: 3,
    connectTimeout: 3000,
    lazyConnect: false,
    // Keep-alive so the connection survives between Lambda invocations
    keepAlive: 10000,
    // Don't block Lambda shutdown
    enableAutoPipelining: true,
  });

  redis.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
  });

  return redis;
}

// ─── Cache key builders ────────────────────────────────────────────────────
// Centralised so we never have typos across files.

export const CacheKeys = {
  /** Full URL record cached after first redirect */
  urlRecord: (code: string) => `url:${code}`,

  /** Analytics summary — invalidated on new click */
  analyticsSummary: (code: string) => `analytics:${code}`,

  /** Rate limit counter for anonymous shorten requests */
  rateLimitShorten: (ip: string) => `rl:shorten:${ip}`,

  /** Rate limit counter for redirects (DDoS protection) */
  rateLimitRedirect: (ip: string) => `rl:redirect:${ip}`,

  /** User's URL list — invalidated on new shorten/delete */
  userUrls: (userId: string) => `user:urls:${userId}`,
} as const;

export const CacheTTL = {
  urlRecord: 60 * 60 * 24,       // 24 hours — hot URLs stay cached
  analyticsSummary: 60 * 5,      // 5 minutes — analytics can be slightly stale
  userUrls: 60 * 2,              // 2 minutes
  rateLimitWindow: 60,           // 1 minute sliding window
} as const;
