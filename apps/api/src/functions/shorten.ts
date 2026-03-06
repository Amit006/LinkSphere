import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  ShortenRequestSchema,
  generateShortCode,
  normalizeUrl,
  generateEventId,
} from '@linksphere/core';
import { UrlRepository, CounterRepository } from '../lib/dynamodb';
import { getRedisClient, CacheKeys } from '../lib/redis';
import { checkRateLimit, getClientIp, RateLimits } from '../middleware/rate-limit';
import { ok, error, rateLimited } from '../lib/response';

/**
 * POST /api/shorten
 * Body: { url: string, alias?: string, ttlSeconds?: number }
 *
 * Flow:
 * 1. Rate limit check (Redis)
 * 2. Validate input (Zod)
 * 3. Check alias availability (DynamoDB)
 * 4. Get next counter ID (DynamoDB atomic increment)
 * 5. Generate Base62 short code
 * 6. Save to DynamoDB
 * 7. Cache in Redis
 * 8. Return short URL
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const ip = getClientIp(event);

  // ── 1. Rate limiting ─────────────────────────────────────────────────────
  const rateLimitConfig = RateLimits.shorten.anonymous;
  const rateLimit = await checkRateLimit(
    CacheKeys.rateLimitShorten(ip),
    rateLimitConfig.limit,
    rateLimitConfig.windowMs
  );

  if (!rateLimit.allowed) {
    return rateLimited(rateLimit.resetAt);
  }

  // ── 2. Parse & validate input ─────────────────────────────────────────────
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return error('Invalid JSON body', 'INVALID_JSON', 400);
  }

  const parsed = ShortenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return error(parsed.error.errors[0]?.message ?? 'Validation failed', 'VALIDATION_ERROR', 400);
  }

  const { url, alias, ttlSeconds } = parsed.data;
  const normalizedUrl = normalizeUrl(url);

  // ── 3. Handle custom alias ────────────────────────────────────────────────
  let shortCode: string;

  if (alias) {
    // Check alias is not taken
    const existing = await UrlRepository.getByCode(alias);
    if (existing) {
      return error(`Alias "${alias}" is already taken`, 'ALIAS_TAKEN', 409);
    }
    shortCode = alias;
  } else {
    // ── 4. Get next atomic counter ──────────────────────────────────────────
    // The counter ensures globally unique, monotonically increasing IDs
    const counter = await CounterRepository.increment('url-counter');

    // ── 5. Generate Base62 short code ───────────────────────────────────────
    shortCode = generateShortCode(counter);
  }

  // ── 6. Build and save URL record ──────────────────────────────────────────
  const now = new Date().toISOString();
  const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;

  const urlRecord = {
    shortCode,
    originalUrl: normalizedUrl,
    userId: null, // TODO: extract from JWT when auth is added
    createdAt: now,
    expiresAt,
    alias: alias ?? null,
    clickCount: 0,
    isActive: true,
  };

  try {
    await UrlRepository.create(urlRecord);
  } catch (err: unknown) {
    // ConditionalCheckFailedException means code collision (extremely rare with Base62)
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return error('Short code collision, please retry', 'COLLISION', 409);
    }
    console.error('[shorten] DynamoDB error:', err);
    return error('Failed to create short URL', 'INTERNAL_ERROR', 500);
  }

  // ── 7. Cache in Redis (warm cache before first redirect) ──────────────────
  const redis = getRedisClient();
  await redis.setex(
    CacheKeys.urlRecord(shortCode),
    24 * 60 * 60, // 24 hours
    JSON.stringify(urlRecord)
  );

  const baseUrl = process.env['BASE_URL'] ?? 'https://lnk.sph';
  return ok(
    {
      shortCode,
      shortUrl: `${baseUrl}/${shortCode}`,
      originalUrl: normalizedUrl,
      expiresAt,
    },
    201
  );
};
