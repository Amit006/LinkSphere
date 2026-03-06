import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { isValidShortCode, anonymizeIp, generateEventId } from '@linksphere/core';
import { UrlRepository } from '../lib/dynamodb';
import { getRedisClient, CacheKeys, CacheTTL } from '../lib/redis';
import { checkRateLimit, getClientIp, RateLimits } from '../middleware/rate-limit';
import { redirect, error, rateLimited } from '../lib/response';
import { recordClick } from '../services/analytics.service';

/**
 * GET /{code}
 * The most-called Lambda in the system — needs to be as fast as possible.
 *
 * Performance strategy:
 * 1. Check Redis cache first (sub-millisecond)
 * 2. If cache miss, fetch from DynamoDB (single-digit ms)
 * 3. Re-populate cache on miss
 * 4. Fire click event asynchronously (don't block redirect)
 *
 * Target: p99 < 50ms for warm cache hit.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const code = event.pathParameters?.['code'] ?? '';

  // ── Validate code format immediately ──────────────────────────────────────
  if (!isValidShortCode(code)) {
    return error('Invalid short code', 'INVALID_CODE', 400);
  }

  const ip = getClientIp(event);

  // ── Rate limit (DDoS protection) ──────────────────────────────────────────
  const rateLimit = await checkRateLimit(
    CacheKeys.rateLimitRedirect(ip),
    RateLimits.redirect.limit,
    RateLimits.redirect.windowMs
  );

  if (!rateLimit.allowed) {
    return rateLimited(rateLimit.resetAt);
  }

  // ── 1. Try Redis cache ────────────────────────────────────────────────────
  const redis = getRedisClient();
  const cacheKey = CacheKeys.urlRecord(code);
  const cached = await redis.get(cacheKey);

  let originalUrl: string | null = null;
  let isActive = true;
  let expiresAt: string | null = null;

  if (cached) {
    // Cache HIT — fastest path
    const record = JSON.parse(cached);
    originalUrl = record.originalUrl;
    isActive = record.isActive;
    expiresAt = record.expiresAt;
  } else {
    // Cache MISS — fetch from DynamoDB and re-populate cache
    const record = await UrlRepository.getByCode(code);

    if (!record) {
      return error('Short URL not found', 'NOT_FOUND', 404);
    }

    originalUrl = record.originalUrl;
    isActive = record.isActive;
    expiresAt = record.expiresAt;

    // Re-populate cache
    await redis.setex(cacheKey, CacheTTL.urlRecord, JSON.stringify(record));
  }

  // ── Check URL is still active ─────────────────────────────────────────────
  if (!isActive) {
    return error('This link has been deactivated', 'DEACTIVATED', 410);
  }

  // ── Check expiry ──────────────────────────────────────────────────────────
  if (expiresAt && new Date(expiresAt) < new Date()) {
    return error('This link has expired', 'EXPIRED', 410);
  }

  // ── Fire click analytics (async, non-blocking) ────────────────────────────
  // We deliberately do NOT await this. The user gets their redirect immediately.
  // Interview talking point: "Decoupling analytics from the redirect path keeps
  // p99 latency low. A slow PostgreSQL write never delays a redirect."
  recordClick({
    id: generateEventId(),
    shortCode: code,
    clickedAt: new Date().toISOString(),
    userAgent: event.headers['user-agent'] ?? null,
    ip: anonymizeIp(ip),
    referer: event.headers['referer'] ?? event.headers['referrer'] ?? null,
    // CloudFront geo headers (available when deployed behind CloudFront)
    country: event.headers['cloudfront-viewer-country'] ?? null,
    region: event.headers['cloudfront-viewer-country-region'] ?? null,
    city: event.headers['cloudfront-viewer-city'] ?? null,
  }).catch((err) => {
    // Log but never fail the redirect for an analytics error
    console.error('[redirect] Failed to record click:', err);
  });

  return redirect(originalUrl!);
};
