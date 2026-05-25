import crypto from 'crypto';

/**
 * Anonymize an IP address for GDPR compliance.
 * IPv4: zero out last octet. IPv6: zero out last 80 bits.
 */
export function anonymizeIp(ip: string): string {
  if (ip.includes(':')) {
    // IPv6 — keep first 48 bits1
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + ':0000:0000:0000:0000:0000';
  }
  // IPv4 — zero out last octet
  const parts = ip.split('.');
  return parts.slice(0, 3).join('.') + '.0';
}

/**
 * Generate a cryptographically random ID for click events.
 */
export function generateEventId(): string {
  return crypto.randomUUID();
}

/**
 * Normalize a URL: trim whitespace, ensure consistent trailing slash handling.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

/**
 * Extract domain from a URL for display purposes.
 * "https://www.google.com/search?q=foo" → "google.com"
 */
export function extractDomain(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Sleep for N milliseconds — useful in retry logic.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff.
 * Interview talking point: "I added retry logic to the DynamoDB writes
 * to handle transient failures without failing the request."
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 100
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * Math.pow(2, attempt - 1));
      }
    }
  }

  throw lastError;
}
