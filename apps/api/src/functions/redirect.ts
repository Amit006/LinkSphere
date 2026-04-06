import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { isValidShortCode, anonymizeIp, generateEventId } from '@linksphere/core';
import { UrlRepository } from '../lib/dynamodb';
import { getRedisClient, CacheKeys, CacheTTL } from '../lib/redis';
import { checkRateLimit, getClientIp, RateLimits } from '../middleware/rate-limit';
import { redirect, error, rateLimited } from '../lib/response';
import { recordClick } from '../services/analytics.service';

/**
 * GET /{code}
 *
 * Performance strategy:
 * 1. Start click recording immediately (parallel with lookup)
 * 2. Check Redis cache first (sub-millisecond)
 * 3. If cache miss, fetch from DynamoDB
 * 4. Await click recording, then redirect
 */

// ─── IP Geolocation ────────────────────────────────────────────────────────
// Uses ip-api.com free tier (45 req/min) — no API key needed
// In production: use CloudFront geo headers (free, no rate limit)
async function getGeoFromIp(ip: string): Promise<{
  country: string | null;
  region: string | null;
  city: string | null;
}> {
  // Skip for private/local IPs
  if (ip === 'unknown' || ip.startsWith('192.168') || ip.startsWith('127.') || ip.startsWith('10.')) {
    return { country: null, region: null, city: null };
  }

  try {
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,countryCode,regionName,city`,
      { signal: AbortSignal.timeout(2000) } // 2s timeout
    );
    const data = await res.json() as {
      status: string;
      countryCode?: string;
      regionName?: string;
      city?: string;
    };

    if (data.status === 'success') {
      return {
        country: data.countryCode ?? null,
        region: data.regionName ?? null,
        city: data.city ?? null,
      };
    }
  } catch {
    // Geo lookup failed — not critical, continue without it
  }
  return { country: null, region: null, city: null };
}

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = true;
  const code = event.pathParameters?.['code'] ?? '';
  const ip = getClientIp(event);

  // ── Get geo data + start click recording in parallel with URL lookup ──────
  // CloudFront headers take priority (free, no rate limit)
  // Fall back to ip-api.com for direct API Gateway access
  const country =
    event.headers['cloudfront-viewer-country'] ??
    event.headers['CloudFront-Viewer-Country'] ?? null;

  const region =
    event.headers['cloudfront-viewer-country-region'] ??
    event.headers['CloudFront-Viewer-Country-Region'] ?? null;

  const city =
    event.headers['cloudfront-viewer-city'] ??
    event.headers['CloudFront-Viewer-City'] ?? null;

  // Start geo lookup in parallel if no CloudFront headers
  const geoPromise = (!country)
    ? getGeoFromIp(ip)
    : Promise.resolve({ country, region, city });

  // Start click recording promise early (will be populated after URL lookup)
  let clickPromiseResolver: (() => void) | null = null;
  const clickBarrier = new Promise<void>(resolve => { clickPromiseResolver = resolve; });

  // ── Validate code ─────────────────────────────────────────────────────────
  if (!isValidShortCode(code)) {
    return error('Invalid short code', 'INVALID_CODE', 400);
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  const rateLimit = await checkRateLimit(
    CacheKeys.rateLimitRedirect(ip),
    RateLimits.redirect.limit,
    RateLimits.redirect.windowMs
  );

  if (!rateLimit.allowed) {
    return rateLimited(rateLimit.resetAt);
  }

  // ── Redis cache ───────────────────────────────────────────────────────────
  const redis = getRedisClient();
  const cacheKey = CacheKeys.urlRecord(code);
  const cached = await redis.get(cacheKey);

  let originalUrl: string | null = null;
  let isActive = true;
  let expiresAt: string | null = null;

  if (cached) {
    const record = JSON.parse(cached);
    originalUrl = record.originalUrl;
    isActive = record.isActive;
    expiresAt = record.expiresAt;
  } else {
    const record = await UrlRepository.getByCode(code);
    if (!record) return error('Short URL not found', 'NOT_FOUND', 404);
    originalUrl = record.originalUrl;
    isActive = record.isActive;
    expiresAt = record.expiresAt;
    await redis.setex(cacheKey, CacheTTL.urlRecord, JSON.stringify(record));
  }

  if (!isActive) return error('This link has been deactivated', 'DEACTIVATED', 410);
  if (expiresAt && new Date(expiresAt) < new Date()) {
    return error('This link has expired', 'EXPIRED', 410);
  }

  // ── Record click (await geo + write to DB) ────────────────────────────────
  const geo = await geoPromise;

  // API Gateway lowercases headers, CloudFront keeps original case
  const userAgent =
    event.headers['user-agent'] ??
    event.headers['User-Agent'] ??
    null;

  const referer =
    event.headers['referer'] ??
    event.headers['Referer'] ??
    event.headers['referrer'] ??
    null;

  const clickPromise = recordClick({
    id: generateEventId(),
    shortCode: code,
    clickedAt: new Date().toISOString(),
    userAgent,
    ip: anonymizeIp(ip),
    referer,
    country: geo.country,
    region: geo.region,
    city: geo.city,
  }).catch((err) => {
    console.error('[redirect] Failed to record click:', err.message);
  });

  await clickPromise;
  return redirect(originalUrl!);
};