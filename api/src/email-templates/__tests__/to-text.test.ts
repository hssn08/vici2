// N02 — html-to-text conversion tests.

import { describe, it, expect } from 'vitest';
import { htmlToText } from '../to-text.js';

describe('htmlToText', () => {
  it('strips bold tags but preserves text', () => {
    const result = htmlToText('<p>Hello <strong>World</strong></p>');
    expect(result.trim()).toBe('Hello World');
  });

  it('appends link href when text differs from href', () => {
    const result = htmlToText('<a href="https://example.com">Click here</a>');
    expect(result).toContain('Click here');
    expect(result).toContain('https://example.com');
  });

  it('hides link href when same as text (hideLinkHrefIfSameAsText)', () => {
    const result = htmlToText(
      '<a href="https://example.com">https://example.com</a>',
    );
    // Should not have the URL twice
    const count = (result.match(/https:\/\/example\.com/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('skips img tags (format: skip)', () => {
    const result = htmlToText(
      '<img src="https://example.com/logo.png" alt="Logo">',
    );
    expect(result.trim()).toBe('');
  });

  it('wraps long paragraphs at 76 characters', () => {
    const longText = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
    const result = htmlToText(`<p>${longText}</p>`);
    const lines = result.split('\n').filter((l) => l.length > 0);
    const maxLen = Math.max(...lines.map((l) => l.length));
    expect(maxLen).toBeLessThanOrEqual(76);
  });

  it('converts headings to uppercase text', () => {
    const result = htmlToText('<h2>Callback Due Now</h2>');
    expect(result).toContain('CALLBACK DUE NOW');
  });
});
