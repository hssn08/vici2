// N02 — sanitize-html email allowlist tests.

import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from '../sanitize.js';

describe('sanitizeEmailHtml', () => {
  it('strips script tags', () => {
    const result = sanitizeEmailHtml('<script>alert(1)</script>');
    expect(result).toBe('');
  });

  it('strips on* event handlers from img but keeps src', () => {
    const result = sanitizeEmailHtml(
      '<img onerror="alert(1)" src="https://example.com/logo.png" alt="Logo">',
    );
    expect(result).toContain('src="https://example.com/logo.png"');
    expect(result).not.toContain('onerror');
  });

  it('strips data: URLs from img src', () => {
    const result = sanitizeEmailHtml(
      '<img src="data:image/png;base64,abc123" alt="x">',
    );
    expect(result).not.toContain('data:');
    // img tag may remain but without src, or be stripped entirely
    expect(result).not.toContain('data:image');
  });

  it('strips javascript: hrefs', () => {
    const result = sanitizeEmailHtml('<a href="javascript:void(0)">click</a>');
    expect(result).not.toContain('javascript:');
  });

  it('retains table email attributes', () => {
    const result = sanitizeEmailHtml(
      '<table bgcolor="#ffffff" cellpadding="8" cellspacing="0"><tr><td>x</td></tr></table>',
    );
    expect(result).toContain('bgcolor="#ffffff"');
    expect(result).toContain('cellpadding="8"');
  });

  it('retains font tag for Outlook compat', () => {
    const result = sanitizeEmailHtml('<font color="red">text</font>');
    expect(result).toContain('<font');
    expect(result).toContain('color="red"');
    expect(result).toContain('text');
  });

  it('strips iframe tags', () => {
    const result = sanitizeEmailHtml('<iframe src="https://evil.com"></iframe>');
    expect(result).not.toContain('iframe');
  });

  it('retains center tag', () => {
    const result = sanitizeEmailHtml('<center>hello</center>');
    expect(result).toContain('<center>');
  });

  it('retains https img src', () => {
    const result = sanitizeEmailHtml(
      '<img src="https://example.com/logo.png" alt="Logo" width="100">',
    );
    expect(result).toContain('src="https://example.com/logo.png"');
  });

  it('strips http img src (only https allowed for img)', () => {
    const result = sanitizeEmailHtml('<img src="http://example.com/img.png" alt="x">');
    // http is not in allowedSchemesByTag for img
    expect(result).not.toContain('src="http://');
  });
});
