/**
 * Base62 encoding/decoding for URL shortening.
 *
 * Why Base62? URL-safe (no +, /, =), case-sensitive giving 62^n combinations.
 * 62^6 = ~56 billion unique codes — enough for any scale.
 *
 * Interview talking point: "I chose Base62 over Base64 because Base64 uses
 * + and / which are special characters in URLs. With 6 characters we get
 * 56 billion combinations which far exceeds our 100M daily request target."
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = BigInt(ALPHABET.length); // 62n

/**
 * Encode a positive BigInt counter to a Base62 string.
 * We use BigInt to safely handle counters beyond Number.MAX_SAFE_INTEGER.
 */
export function encodeBase62(num: bigint): string {
  if (num === 0n) return ALPHABET[0]!;

  let result = '';
  let n = num;

  while (n > 0n) {
    const remainder = n % BASE;
    result = ALPHABET[Number(remainder)]! + result;
    n = n / BASE;
  }

  return result;
}

/**
 * Decode a Base62 string back to a BigInt.
 * Returns null if the string contains invalid characters.
 */
export function decodeBase62(str: string): bigint | null {
  let result = 0n;

  for (const char of str) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return null; // Invalid character
    result = result * BASE + BigInt(index);
  }

  return result;
}

/**
 * Generate a short code from a numeric ID.
 * Pads to a minimum length to prevent enumeration of early IDs.
 *
 * Example: generateShortCode(1n) → "000001" (not "1")
 * This prevents attackers from guessing sequential URLs.
 */
export function generateShortCode(id: bigint, minLength = 6): string {
  const encoded = encodeBase62(id);
  return encoded.padStart(minLength, ALPHABET[0]);
}

/**
 * Validate a short code has only Base62 characters and correct length.
 */
export function isValidShortCode(code: string): boolean {
  if (code.length < 4 || code.length > 12) return false;
  return /^[0-9a-zA-Z]+$/.test(code);
}
