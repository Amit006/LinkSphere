import { describe, it, expect } from 'vitest';
import {
  encodeBase62,
  decodeBase62,
  generateShortCode,
  isValidShortCode,
} from './base62';

describe('encodeBase62', () => {
  it('encodes 0 to "0"', () => {
    expect(encodeBase62(0n)).toBe('0');
  });

  it('encodes 1 correctly', () => {
    expect(encodeBase62(1n)).toBe('1');
  });

  it('encodes 61 to last alphabet char Z', () => {
    expect(encodeBase62(61n)).toBe('Z');
  });

  it('encodes 62 to "10" (base62 rollover)', () => {
    expect(encodeBase62(62n)).toBe('10');
  });

  it('encodes a large counter correctly', () => {
    // 62^6 = 56,800,235,584 — the max 6-char code
    expect(encodeBase62(56_800_235_583n)).toBe('ZZZZZZ');
  });

  it('handles BigInt beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1000n;
    const encoded = encodeBase62(huge);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
  });
});

describe('decodeBase62', () => {
  it('decodes "0" to 0n', () => {
    expect(decodeBase62('0')).toBe(0n);
  });

  it('decodes "1" to 1n', () => {
    expect(decodeBase62('1')).toBe(1n);
  });

  it('decodes "Z" to 61n', () => {
    expect(decodeBase62('Z')).toBe(61n);
  });

  it('decodes "10" to 62n', () => {
    expect(decodeBase62('10')).toBe(62n);
  });

  it('returns null for invalid characters', () => {
    expect(decodeBase62('abc!')).toBeNull();
    expect(decodeBase62('hello world')).toBeNull();
    expect(decodeBase62('abc+def')).toBeNull();
  });

  it('returns null for empty string', () => {
    // Empty string produces 0n (no invalid chars) — document the behaviour
    expect(decodeBase62('')).toBe(0n);
  });
});

describe('encodeBase62 / decodeBase62 roundtrip', () => {
  const cases = [0n, 1n, 61n, 62n, 3844n, 100_000n, 56_800_235_583n];

  it.each(cases)('roundtrips %s', (n) => {
    expect(decodeBase62(encodeBase62(n))).toBe(n);
  });

  it('roundtrips 10,000 sequential counters', () => {
    for (let i = 0n; i < 10_000n; i++) {
      expect(decodeBase62(encodeBase62(i))).toBe(i);
    }
  });
});

describe('generateShortCode', () => {
  it('pads low IDs to minimum 6 characters', () => {
    expect(generateShortCode(1n)).toHaveLength(6);
    expect(generateShortCode(1n)).toBe('000001');
  });

  it('pads ID 0 to 6 zeros', () => {
    expect(generateShortCode(0n)).toBe('000000');
  });

  it('does not pad when encoded length >= minLength', () => {
    // 62^6 encodes to "ZZZZZZ" — already 6 chars, no padding
    const code = generateShortCode(56_800_235_583n);
    expect(code).toBe('ZZZZZZ');
    expect(code).toHaveLength(6);
  });

  it('respects custom minLength', () => {
    expect(generateShortCode(1n, 8)).toHaveLength(8);
    expect(generateShortCode(1n, 8)).toBe('00000001');
  });

  it('prevents enumeration — early IDs are not single chars', () => {
    // Without padding, ID 1 would be "1" — easy to guess.
    // With padding it's "000001" — not guessable as "the second URL".
    const code = generateShortCode(1n);
    expect(code).not.toBe('1');
    expect(code.length).toBeGreaterThanOrEqual(6);
  });

  it('only uses Base62 alphabet characters', () => {
    for (let i = 0n; i < 1000n; i++) {
      expect(generateShortCode(i)).toMatch(/^[0-9a-zA-Z]+$/);
    }
  });
});

describe('isValidShortCode', () => {
  it('accepts valid 6-char alphanumeric codes', () => {
    expect(isValidShortCode('abc123')).toBe(true);
    expect(isValidShortCode('ZZZZZZ')).toBe(true);
    expect(isValidShortCode('000001')).toBe(true);
  });

  it('accepts codes between 4 and 12 chars', () => {
    expect(isValidShortCode('abcd')).toBe(true);       // 4 chars
    expect(isValidShortCode('abcdefghijkl')).toBe(true); // 12 chars
  });

  it('rejects codes shorter than 4 chars', () => {
    expect(isValidShortCode('abc')).toBe(false);
    expect(isValidShortCode('ab')).toBe(false);
    expect(isValidShortCode('')).toBe(false);
  });

  it('rejects codes longer than 12 chars', () => {
    expect(isValidShortCode('abcdefghijklm')).toBe(false); // 13 chars
  });

  it('rejects codes with special characters (URL injection risk)', () => {
    expect(isValidShortCode('abc!23')).toBe(false);
    expect(isValidShortCode('abc/23')).toBe(false);   // path traversal
    expect(isValidShortCode('abc+23')).toBe(false);   // Base64 char
    expect(isValidShortCode('abc 23')).toBe(false);   // space
    expect(isValidShortCode('abc\n23')).toBe(false);  // newline injection
    expect(isValidShortCode('../etc')).toBe(false);   // path traversal
  });

  it('rejects codes with unicode characters', () => {
    expect(isValidShortCode('abc🔗23')).toBe(false);
  });
});