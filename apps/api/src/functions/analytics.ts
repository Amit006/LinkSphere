import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { isValidShortCode } from '@linksphere/core';
import { UrlRepository } from '../lib/dynamodb';
import { getRedisClient, CacheKeys, CacheTTL } from '../lib/redis';
import { getAnalyticsSummary } from '../services/analytics.service';
import { ok, error } from '../lib/response';

/**
 * GET /api/analytics/{code}
 * Returns click analytics for a short code.
 * Results are cached in Redis for 5 minutes.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const code = event.pathParameters?.['code'] ?? '';

  if (!isValidShortCode(code)) {
    return error('Invalid short code', 'INVALID_CODE', 400);
  }

  // Verify URL exists
  const urlRecord = await UrlRepository.getByCode(code);
  if (!urlRecord) {
    return error('Short URL not found', 'NOT_FOUND', 404);
  }

  // Check Redis cache
  const redis = getRedisClient();
  const cacheKey = CacheKeys.analyticsSummary(code);
  const cached = await redis.get(cacheKey);

  if (cached) {
    return ok(JSON.parse(cached));
  }

  // Cache miss — compute from PostgreSQL
  const summary = await getAnalyticsSummary(code);

  // Cache the result
  await redis.setex(cacheKey, CacheTTL.analyticsSummary, JSON.stringify(summary));

  return ok(summary);
};
