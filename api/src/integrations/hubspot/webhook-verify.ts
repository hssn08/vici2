// N04 — HubSpot webhook HMAC signature verification
// Spec: hash = SHA256(client_secret + raw_body_string)
// Header: X-HubSpot-Signature

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Verify a HubSpot webhook signature.
 * Returns true if the signature is valid, false otherwise.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyHubspotWebhookSignature(
  clientSecret: string,
  rawBody: string | Buffer,
  signatureHeader: string,
): boolean {
  if (!signatureHeader || !clientSecret) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
  const hash = createHash('sha256')
    .update(clientSecret + body)
    .digest('hex');
  try {
    const sigBuf = Buffer.from(signatureHeader.toLowerCase(), 'hex');
    const hashBuf = Buffer.from(hash.toLowerCase(), 'hex');
    if (sigBuf.length !== hashBuf.length) return false;
    return timingSafeEqual(sigBuf, hashBuf);
  } catch {
    return false;
  }
}
