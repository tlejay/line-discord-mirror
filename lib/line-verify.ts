import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the LINE webhook signature.
 *
 * LINE signs the raw request body with HMAC-SHA256 and the channel secret,
 * then Base64-encodes it into x-line-signature. Timing-safe comparison
 * prevents length-based oracle attacks.
 */
export function verify(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
