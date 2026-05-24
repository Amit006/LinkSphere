import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

// vi.hoisted ensures mockRedis is available when vi.mock factories run
const mockRedis = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  setex: vi.fn().mockResolvedValue('OK'),
  eval: vi.fn().mockResolvedValue([1, 299]),
  status: 'ready',
  on: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock lib/redis entirely — prevents ioredis from ever connecting
vi.mock('../lib/redis', () => ({
  getRedisClient: () => mockRedis,
  CacheKeys: {
    urlRecord: (code: string) => `url:${code}`,
    rateLimitRedirect: (ip: string) => `rl:redirect:${ip}`,
    analyticsSummary: (code: string) => `analytics:${code}`,
    userUrls: (userId: string) => `user:urls:${userId}`,
    rateLimitShorten: (ip: string) => `rl:shorten:${ip}`,
  },
  CacheTTL: { urlRecord: 86400, analyticsSummary: 300, userUrls: 120 },
}));

vi.mock('../lib/dynamodb', () => ({
  UrlRepository: {
    getByCode: vi.fn(),
    incrementClickCount: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../services/analytics.service', () => ({
  recordClick: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.hoisted(() => vi.fn());
global.fetch = mockFetch;

import { handler } from './redirect';
import { UrlRepository } from '../lib/dynamodb';
import { recordClick } from '../services/analytics.service';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function makeEvent(code: string, headers: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    pathParameters: { code },
    headers: { 'user-agent': CHROME_UA, ...headers },
    requestContext: { identity: { sourceIp: '49.249.60.0' } } as any,
    body: null, multiValueHeaders: {}, httpMethod: 'GET',
    isBase64Encoded: false, path: `/${code}`,
    queryStringParameters: null, multiValueQueryStringParameters: null,
    stageVariables: null, resource: '/{code}',
  } as unknown as APIGatewayProxyEvent;
}

function makeContext(): Context {
  return {
    callbackWaitsForEmptyEventLoop: true, functionName: 'test',
    functionVersion: '1', invokedFunctionArn: 'arn:test',
    memoryLimitInMB: '256', awsRequestId: 'test-id',
    logGroupName: '/test', logStreamName: 'test',
    getRemainingTimeInMillis: () => 29000,
    done: vi.fn(), fail: vi.fn(), succeed: vi.fn(),
  };
}

const activeUrl = {
  shortCode: 'amitLn',
  originalUrl: 'https://www.linkedin.com/in/amit-nayek-381b7349/',
  isActive: true, expiresAt: null, userId: null,
  clickCount: 5, alias: null, createdAt: new Date().toISOString(),
};

describe('redirect handler', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue([1, 299]);
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ status: 'success', countryCode: 'IN', regionName: 'Telangana', city: 'Hyderabad' }),
    });
  });

  it('returns 301 for valid active URL', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue(activeUrl);
    const result = await handler(makeEvent('amitLn'), makeContext());
    expect(result.statusCode).toBe(301);
    expect(result.headers?.Location).toBe('https://www.linkedin.com/in/amit-nayek-381b7349/');
  });

  it('records click with user agent', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue(activeUrl);
    await handler(makeEvent('amitLn'), makeContext());
    expect(recordClick).toHaveBeenCalledWith(expect.objectContaining({ shortCode: 'amitLn', userAgent: expect.stringContaining('Chrome') }));
  });

  it('records geo from ip-api.com', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue(activeUrl);
    await handler(makeEvent('amitLn'), makeContext());
    expect(recordClick).toHaveBeenCalledWith(expect.objectContaining({ country: 'IN', region: 'Telangana', city: 'Hyderabad' }));
  });

  it('uses CloudFront headers and skips ip-api.com', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue(activeUrl);
    await handler(makeEvent('amitLn', {
      'cloudfront-viewer-country': 'US',
      'cloudfront-viewer-country-region': 'California',
      'cloudfront-viewer-city': 'San Francisco',
    }), makeContext());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(recordClick).toHaveBeenCalledWith(expect.objectContaining({ country: 'US', region: 'California', city: 'San Francisco' }));
  });

  it('uses Redis cache and skips DynamoDB', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(activeUrl));
    const result = await handler(makeEvent('amitLn'), makeContext());
    expect(UrlRepository.getByCode).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(301);
  });

  it('records referer header', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue(activeUrl);
    await handler(makeEvent('amitLn', { 'referer': 'https://www.google.com' }), makeContext());
    expect(recordClick).toHaveBeenCalledWith(expect.objectContaining({ referer: 'https://www.google.com' }));
  });

  it('returns 400 for invalid short code', async () => {
    const result = await handler(makeEvent('bad code!'), makeContext());
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('INVALID_CODE');
  });

  it('returns 404 for unknown short code', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue(null);
    const result = await handler(makeEvent('notfound'), makeContext());
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 410 for deactivated URL', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue({ ...activeUrl, isActive: false });
    const result = await handler(makeEvent('amitLn'), makeContext());
    expect(result.statusCode).toBe(410);
    expect(JSON.parse(result.body).error.code).toBe('DEACTIVATED');
  });

  it('returns 410 for expired URL', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue({ ...activeUrl, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const result = await handler(makeEvent('amitLn'), makeContext());
    expect(result.statusCode).toBe(410);
    expect(JSON.parse(result.body).error.code).toBe('EXPIRED');
  });

  it('returns 429 when rate limited', async () => {
    mockRedis.eval.mockResolvedValue([0, 0]);
    const result = await handler(makeEvent('amitLn'), makeContext());
    expect(result.statusCode).toBe(429);
  });

  it('still redirects when geo lookup fails', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue(activeUrl);
    mockFetch.mockRejectedValue(new Error('Network timeout'));
    const result = await handler(makeEvent('amitLn'), makeContext());
    expect(result.statusCode).toBe(301);
    expect(recordClick).toHaveBeenCalledWith(expect.objectContaining({ country: null, region: null, city: null }));
  });

  it('still redirects when click recording fails', async () => {
    vi.mocked(UrlRepository.getByCode).mockResolvedValue(activeUrl);
    vi.mocked(recordClick).mockRejectedValue(new Error('DB down'));
    const result = await handler(makeEvent('amitLn'), makeContext());
    expect(result.statusCode).toBe(301);
  });
});