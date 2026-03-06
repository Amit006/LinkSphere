import type { APIGatewayProxyResult } from 'aws-lambda';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env['ALLOWED_ORIGIN'] ?? '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

export function ok<T>(data: T, statusCode = 200): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify({ success: true, data }),
  };
}

export function error(
  message: string,
  code: string,
  statusCode: number
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify({ success: false, error: { message, code, statusCode } }),
  };
}

export function redirect(url: string): APIGatewayProxyResult {
  return {
    statusCode: 301,
    headers: {
      Location: url,
      // Cache the redirect at CloudFront for 1 hour
      'Cache-Control': 'public, max-age=3600',
    },
    body: '',
  };
}

export function rateLimited(resetAt: number): APIGatewayProxyResult {
  return {
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(resetAt - Math.floor(Date.now() / 1000)),
      ...CORS_HEADERS,
    },
    body: JSON.stringify({
      success: false,
      error: { message: 'Too many requests', code: 'RATE_LIMITED', statusCode: 429 },
    }),
  };
}
