/**
 * Shared types across the monorepo.
 * Both the Lambda API and Next.js frontend import from here.
 */

// ─── URL Entity ────────────────────────────────────────────────────────────

export interface ShortenedUrl {
  /** The short code, e.g. "xK3p9q" */
  shortCode: string;
  /** Original destination URL */
  originalUrl: string;
  /** User who created it (null = anonymous) */
  userId: string | null;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp or null for never-expiring */
  expiresAt: string | null;
  /** Custom alias if provided, e.g. "my-blog" */
  alias: string | null;
  /** Click count — eventually consistent from analytics */
  clickCount: number;
  /** Whether this URL is active */
  isActive: boolean;
}

// ─── Click / Analytics Event ────────────────────────────────────────────────

export interface ClickEvent {
  id: string;
  shortCode: string;
  /** ISO timestamp */
  clickedAt: string;
  /** Parsed from User-Agent */
  browser: string | null;
  os: string | null;
  device: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  /** ISO 3166-1 alpha-2 country code, e.g. "US" */
  country: string | null;
  /** e.g. "California" */
  region: string | null;
  /** Referrer header */
  referer: string | null;
  /** Anonymized IP (last octet zeroed) */
  ipHash: string | null;
}

// ─── API Request/Response shapes ────────────────────────────────────────────

export interface ShortenRequest {
  url: string;
  /** Optional custom alias */
  alias?: string;
  /** Optional expiry in seconds from now */
  ttlSeconds?: number;
}

export interface ShortenResponse {
  shortCode: string;
  shortUrl: string;
  originalUrl: string;
  expiresAt: string | null;
}

export interface AnalyticsSummary {
  shortCode: string;
  totalClicks: number;
  uniqueClicks: number;
  /** Last 30 days, keyed by YYYY-MM-DD */
  clicksByDay: Record<string, number>;
  topCountries: Array<{ country: string; count: number }>;
  topReferers: Array<{ referer: string; count: number }>;
  deviceBreakdown: Record<'desktop' | 'mobile' | 'tablet' | 'unknown', number>;
}

// ─── API Error ───────────────────────────────────────────────────────────────

export interface ApiError {
  code: string;
  message: string;
  statusCode: number;
}

export type ApiResult<T> = { success: true; data: T } | { success: false; error: ApiError };

// ─── Rate Limiting ───────────────────────────────────────────────────────────

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number; // Unix timestamp
}

// ─── User ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  createdAt: string;
  plan: 'free' | 'pro';
}
