// N02 — HMAC unsubscribe token generation and verification.
// Token encodes userId + category + expiry + HMAC signature.
// TTL: 90 days. Secret: VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET env var.

import { createHmac } from 'crypto';

const EXPIRY_DAYS = 90;

function getSecret(): string {
  const secret = process.env.VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET;
  if (!secret) throw new Error('VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET is not set');
  return secret;
}

export function generateUnsubscribeToken(
  userId: bigint,
  category: string,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 86400;
  const message = `${userId}:${category}:${expiresAt}`;
  const sig = createHmac('sha256', getSecret()).update(message).digest('hex');
  return Buffer.from(
    JSON.stringify({ userId: String(userId), category, expiresAt, sig }),
  ).toString('base64url');
}

export function verifyUnsubscribeToken(
  token: string,
): { userId: bigint; category: string } | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as {
      userId: string;
      category: string;
      expiresAt: number;
      sig: string;
    };

    const { userId, category, expiresAt, sig } = parsed;

    // Check expiry
    if (Math.floor(Date.now() / 1000) > expiresAt) return null;

    // Verify HMAC
    const message = `${userId}:${category}:${expiresAt}`;
    const expected = createHmac('sha256', getSecret())
      .update(message)
      .digest('hex');

    if (sig !== expected) return null;

    return { userId: BigInt(userId), category };
  } catch {
    return null;
  }
}
