import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { UrlRepository } from '../lib/dynamodb';
import { getRedisClient, CacheKeys } from '../lib/redis';
import { ok, error } from '../lib/response';

// ─── GET /api/urls ────────────────────────────────────────────────────────

export const listHandler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  // TODO: extract userId from JWT token
  // For now, return a placeholder until auth is implemented
  const userId = event.headers['x-user-id'];

  if (!userId) {
    return error('Authentication required', 'UNAUTHORIZED', 401);
  }

  const redis = getRedisClient();
  const cacheKey = CacheKeys.userUrls(userId);
  const cached = await redis.get(cacheKey);

  if (cached) {
    return ok(JSON.parse(cached));
  }

  const urls = await UrlRepository.getByUserId(userId);

  await redis.setex(cacheKey, 120, JSON.stringify(urls));

  return ok(urls);
};

// ─── DELETE /api/urls/{code} ──────────────────────────────────────────────

export const deleteHandler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const code = event.pathParameters?.['code'] ?? '';
  const userId = event.headers['x-user-id'];

  if (!userId) {
    return error('Authentication required', 'UNAUTHORIZED', 401);
  }

  const urlRecord = await UrlRepository.getByCode(code);

  if (!urlRecord) {
    return error('Short URL not found', 'NOT_FOUND', 404);
  }

  if (urlRecord.userId !== userId) {
    return error('You do not own this URL', 'FORBIDDEN', 403);
  }

  await UrlRepository.deactivate(code);

  // Invalidate caches
  const redis = getRedisClient();
  await Promise.all([
    redis.del(CacheKeys.urlRecord(code)),
    redis.del(CacheKeys.userUrls(userId)),
  ]);

  return ok({ message: 'URL deactivated successfully' });
};
