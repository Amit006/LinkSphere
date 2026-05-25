import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { anonymizeIp, normalizeUrl, extractDomain, withRetry, generateEventId } from './helpers';

describe('anonymizeIp', () => {
  describe('IPv4', () => {
    it('zeroes the last octet', () => {
      expect(anonymizeIp('192.168.1.42')).toBe('192.168.1.0');
    });

    it('preserves first three octets', () => {
      expect(anonymizeIp('10.20.30.99')).toBe('10.20.30.0');
    });

    it('handles edge cases (0.0.0.x)', () => {
      expect(anonymizeIp('0.0.0.255')).toBe('0.0.0.0');
    });
  });

  describe('IPv6', () => {
    it('keeps first 48 bits (3 groups) and zeroes the rest', () => {
      const result = anonymizeIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
      expect(result).toBe('2001:0db8:85a3:0000:0000:0000:0000:0000');
    });

    it('handles short IPv6', () => {
      const result = anonymizeIp('::1');
      // ::1 splits to ['', '', '1'] — keep first 3 parts
      expect(result).toContain('0000:0000:0000:0000:0000');
    });
  });
});

describe('normalizeUrl', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com/');
  });

  it('returns a consistent trailing slash for root URLs', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('preserves query params', () => {
    const url = 'https://example.com/path?foo=bar&baz=1';
    expect(normalizeUrl(url)).toBe('https://example.com/path?foo=bar&baz=1');
  });

  it('preserves hash fragments', () => {
    const url = 'https://example.com/page#section';
    expect(normalizeUrl(url)).toBe('https://example.com/page#section');
  });

  it('returns original trimmed string for invalid URLs', () => {
    expect(normalizeUrl('  not-a-url  ')).toBe('not-a-url');
  });

  it('normalises protocol casing', () => {
    expect(normalizeUrl('HTTPS://Example.COM')).toBe('https://example.com/');
  });
});

describe('extractDomain', () => {
  it('strips www prefix', () => {
    expect(extractDomain('https://www.google.com/search?q=foo')).toBe('google.com');
  });

  it('preserves non-www subdomains', () => {
    expect(extractDomain('https://docs.github.com/en/actions')).toBe('docs.github.com');
  });

  it('handles URLs with no path', () => {
    expect(extractDomain('https://example.com')).toBe('example.com');
  });

  it('returns original string for invalid URLs', () => {
    expect(extractDomain('not-a-url')).toBe('not-a-url');
  });

  it('works with ports', () => {
    expect(extractDomain('http://localhost:3000/api')).toBe('localhost');
  });
});

describe('generateEventId', () => {
  it('returns a valid UUID v4', () => {
    const id = generateEventId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('generates unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateEventId()));
    expect(ids.size).toBe(1000);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const promise = withRetry(fn, 3, 100);
    // Advance past the 100ms backoff (attempt 1 delay)
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    const assertion = expect(withRetry(fn, 3, 10)).rejects.toThrow('always fails');
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses exponential backoff between attempts', async () => {
    const delays: number[] = [];
    let lastCall = Date.now();

    const fn = vi.fn().mockImplementation(() => {
      const now = Date.now();
      delays.push(now - lastCall);
      lastCall = now;
      return Promise.reject(new Error('fail'));
    });

    const promise = withRetry(fn, 3, 100).catch(() => { });
    await vi.runAllTimersAsync();
    await promise;

    // Attempt 2 should wait ~100ms, attempt 3 ~200ms
    expect(delays[1]).toBeGreaterThanOrEqual(90);
    expect(delays[2]).toBeGreaterThanOrEqual(190);
  });

  it('wraps non-Error thrown values in an Error', async () => {
    // maxAttempts=1 → no sleep() → attach handler BEFORE advancing timers
    // otherwise the promise rejects with no handler = unhandled rejection
    const fn = vi.fn().mockRejectedValue('string error');
    const assertion = expect(withRetry(fn, 1)).rejects.toThrow('string error');
    await vi.runAllTimersAsync();
    await assertion;
  });


});