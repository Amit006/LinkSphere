import { z } from 'zod';

/**
 * Shared Zod schemas.
 * The API validates incoming requests with these.
 * The frontend uses them for form validation — single source of truth.
 */

export const ShortenRequestSchema = z.object({
  url: z
    .string()
    .url('Must be a valid URL')
    .max(2048, 'URL must be under 2048 characters')
    .refine(
      (url) => url.startsWith('http://') || url.startsWith('https://'),
      'URL must start with http:// or https://'
    ),
  alias: z
    .string()
    .min(3, 'Alias must be at least 3 characters')
    .max(50, 'Alias must be under 50 characters')
    .regex(/^[a-zA-Z0-9-_]+$/, 'Alias can only contain letters, numbers, hyphens, underscores')
    .optional(),
  ttlSeconds: z
    .number()
    .int()
    .min(60, 'Minimum TTL is 60 seconds')
    .max(60 * 60 * 24 * 365 * 5, 'Maximum TTL is 5 years')
    .optional(),
});

export const ShortCodeParamSchema = z.object({
  code: z
    .string()
    .min(4)
    .max(12)
    .regex(/^[0-9a-zA-Z]+$/, 'Invalid short code format'),
});

export type ShortenRequestInput = z.infer<typeof ShortenRequestSchema>;
