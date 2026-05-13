// N02 — HMAC unsubscribe token tests.

import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';

// Set the env secret before importing the module
process.env.VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET = 'test-secret-32bytes-long-enough!';

import { generateUnsubscribeToken, verifyUnsubscribeToken } from '../unsubscribe.js';

describe('generateUnsubscribeToken', () => {
  it('produces a base64url-decodable token', () => {
    const token = generateUnsubscribeToken(1n, 'callback_due');
    expect(token).toBeTruthy();
    // Should be valid base64url
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    expect(parsed.userId).toBe('1');
    expect(parsed.category).toBe('callback_due');
    expect(typeof parsed.expiresAt).toBe('number');
    expect(typeof parsed.sig).toBe('string');
  });
});

describe('verifyUnsubscribeToken', () => {
  it('returns payload for a valid token', () => {
    const token = generateUnsubscribeToken(1n, 'callback_due');
    const result = verifyUnsubscribeToken(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(1n);
    expect(result!.category).toBe('callback_due');
  });

  it('returns null for a tampered signature', () => {
    const token = generateUnsubscribeToken(1n, 'callback_due');
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.sig = 'deadbeef'.repeat(8);
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('returns null for an expired token', () => {
    const userId = 1n;
    const category = 'import_complete';
    // Create a token that expired 1 second ago
    const expiresAt = Math.floor(Date.now() / 1000) - 1;
    const secret = process.env.VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET!;
    const message = `${userId}:${category}:${expiresAt}`;
    const sig = createHmac('sha256', secret).update(message).digest('hex');
    const expired = Buffer.from(
      JSON.stringify({ userId: String(userId), category, expiresAt, sig }),
    ).toString('base64url');
    expect(verifyUnsubscribeToken(expired)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(verifyUnsubscribeToken('not-a-valid-token')).toBeNull();
    expect(verifyUnsubscribeToken('')).toBeNull();
  });
});
