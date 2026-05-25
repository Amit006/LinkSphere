import { describe, it, expect } from 'vitest';
import { ShortenRequestSchema, ShortCodeParamSchema } from './schemas';

describe('ShortenRequestSchema', () => {
  describe('url field', () => {
    it('accepts a valid https URL', () => {
      const result = ShortenRequestSchema.safeParse({ url: 'https://example.com' });
      expect(result.success).toBe(true);
    });

    it('accepts a valid http URL', () => {
      const result = ShortenRequestSchema.safeParse({ url: 'http://example.com/path' });
      expect(result.success).toBe(true);
    });

    it('rejects a URL without protocol', () => {
      const result = ShortenRequestSchema.safeParse({ url: 'example.com' });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0]?.message).toContain('valid URL');
    });

    it('rejects ftp:// URLs (not http/https)', () => {
      const result = ShortenRequestSchema.safeParse({ url: 'ftp://example.com' });
      expect(result.success).toBe(false);
    });

    it('rejects javascript: URLs (XSS vector)', () => {
      const result = ShortenRequestSchema.safeParse({ url: 'javascript:alert(1)' });
      expect(result.success).toBe(false);
    });

    it('rejects data: URIs', () => {
      const result = ShortenRequestSchema.safeParse({ url: 'data:text/html,<h1>hi</h1>' });
      expect(result.success).toBe(false);
    });

    it('rejects URLs over 2048 characters', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2048);
      const result = ShortenRequestSchema.safeParse({ url: longUrl });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0]?.message).toContain('2048');
    });

    it('rejects empty string', () => {
      const result = ShortenRequestSchema.safeParse({ url: '' });
      expect(result.success).toBe(false);
    });

    it('rejects missing url field', () => {
      const result = ShortenRequestSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('accepts URLs with query params and fragments', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com/path?foo=bar&baz=1#section',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('alias field (optional)', () => {
    it('accepts a valid alias', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        alias: 'my-blog',
      });
      expect(result.success).toBe(true);
    });

    it('accepts alias with underscores', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        alias: 'my_blog_2024',
      });
      expect(result.success).toBe(true);
    });

    it('rejects alias shorter than 3 characters', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        alias: 'ab',
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0]?.message).toContain('3 characters');
    });

    it('rejects alias longer than 50 characters', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        alias: 'a'.repeat(51),
      });
      expect(result.success).toBe(false);
    });

    it('rejects alias with spaces', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        alias: 'my blog',
      });
      expect(result.success).toBe(false);
    });

    it('rejects alias with special characters (injection risk)', () => {
      const badAliases = ['my/alias', 'my?alias', 'my#alias', 'my&alias', '<script>'];
      for (const alias of badAliases) {
        const result = ShortenRequestSchema.safeParse({
          url: 'https://example.com',
          alias,
        });
        expect(result.success, `Expected failure for alias: ${alias}`).toBe(false);
      }
    });

    it('is optional — omitting it is valid', () => {
      const result = ShortenRequestSchema.safeParse({ url: 'https://example.com' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.alias).toBeUndefined();
      }
    });
  });

  describe('ttlSeconds field (optional)', () => {
    it('accepts valid TTL of 1 hour', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        ttlSeconds: 3600,
      });
      expect(result.success).toBe(true);
    });

    it('rejects TTL under 60 seconds', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        ttlSeconds: 59,
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0]?.message).toContain('60 seconds');
    });

    it('rejects TTL of 0', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        ttlSeconds: 0,
      });
      expect(result.success).toBe(false);
    });

    it('rejects TTL over 5 years', () => {
      const fiveYearsPlus = 60 * 60 * 24 * 365 * 5 + 1;
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        ttlSeconds: fiveYearsPlus,
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer TTL', () => {
      const result = ShortenRequestSchema.safeParse({
        url: 'https://example.com',
        ttlSeconds: 3600.5,
      });
      expect(result.success).toBe(false);
    });

    it('is optional — omitting gives undefined', () => {
      const result = ShortenRequestSchema.safeParse({ url: 'https://example.com' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ttlSeconds).toBeUndefined();
      }
    });
  });
});

describe('ShortCodeParamSchema', () => {
  it('accepts a valid 6-char alphanumeric code', () => {
    const result = ShortCodeParamSchema.safeParse({ code: 'abc123' });
    expect(result.success).toBe(true);
  });

  it('accepts codes 4–12 characters', () => {
    expect(ShortCodeParamSchema.safeParse({ code: 'abcd' }).success).toBe(true);
    expect(ShortCodeParamSchema.safeParse({ code: 'abcdefghijkl' }).success).toBe(true);
  });

  it('rejects codes shorter than 4 chars', () => {
    expect(ShortCodeParamSchema.safeParse({ code: 'abc' }).success).toBe(false);
  });

  it('rejects codes longer than 12 chars', () => {
    expect(ShortCodeParamSchema.safeParse({ code: 'abcdefghijklm' }).success).toBe(false);
  });

  it('rejects codes with special characters', () => {
    expect(ShortCodeParamSchema.safeParse({ code: 'abc!23' }).success).toBe(false);
    expect(ShortCodeParamSchema.safeParse({ code: 'abc/23' }).success).toBe(false);
    expect(ShortCodeParamSchema.safeParse({ code: '../etc' }).success).toBe(false);
  });

  it('rejects missing code field', () => {
    expect(ShortCodeParamSchema.safeParse({}).success).toBe(false);
  });
});