// N02 — sanitize-html wrapper with email-extended allowlist.
// Extends S03 base allowlist with email-specific tags/attributes.

import sanitizeHtml from 'sanitize-html';

const EMAIL_ALLOWED_TAGS = [
  // S03 base
  'p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'blockquote', 'a', 'span', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
  // N02 email extensions
  'img', 'center', 'font',
];

const EMAIL_ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  // S03 base
  '*': ['class', 'id'],
  'a': ['href', 'target', 'rel'],
  // N02 email extensions
  'img': ['src', 'alt', 'width', 'height', 'border', 'style'],
  'table': ['align', 'valign', 'cellpadding', 'cellspacing', 'border', 'bgcolor', 'width', 'height'],
  'td': ['align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan'],
  'th': ['align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan'],
  'font': ['color', 'face', 'size'],
};

const EMAIL_ALLOWED_SCHEMES = ['http', 'https', 'mailto'];

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: EMAIL_ALLOWED_TAGS,
    allowedAttributes: EMAIL_ALLOWED_ATTRIBUTES,
    allowedSchemes: EMAIL_ALLOWED_SCHEMES,
    // Block data: URLs in img src
    allowedSchemesByTag: { img: ['https'] },
    // Block on* event handlers
    disallowedTagsMode: 'discard',
    allowVulnerableTags: false,
  });
}
