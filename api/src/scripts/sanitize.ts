// S03 — Server-side HTML sanitization wrapper.
//
// Uses `sanitize-html` with an explicit allowed-tag + allowed-attribute
// safelist. The body is sanitized both at save time (POST/PATCH) and again
// at render time (belt-and-suspenders for XSS safety).

import sanitizeHtml from "sanitize-html";

// ---------------------------------------------------------------------------
// Allowed tag + attribute policy
// ---------------------------------------------------------------------------

const ALLOWED_TAGS: string[] = [
  // Text-level
  "p", "br", "strong", "b", "em", "i", "u", "s", "del", "ins", "mark",
  "code", "pre", "kbd", "sub", "sup", "small",
  // Structural
  "div", "span", "section", "article", "aside", "header", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "q", "cite",
  "hr", "figure", "figcaption",
  // Table
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  // Link (href restricted to http/https below)
  "a",
];

/**
 * CSS properties permitted in inline `style` attributes.
 * Does NOT allow url(), expressions, or position tricks.
 */
const ALLOWED_CSS_PROPS: string[] = [
  "color", "background-color", "font-weight", "font-style", "font-size",
  "text-decoration", "text-align", "margin", "margin-top", "margin-bottom",
  "margin-left", "margin-right", "padding", "padding-top", "padding-bottom",
  "padding-left", "padding-right", "border", "border-radius",
  "line-height", "letter-spacing", "word-spacing",
  "list-style-type", "list-style-position",
  "width", "max-width", "height",
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,

  allowedAttributes: {
    // All elements: class, id, style (CSS prop allowlist below), data-* stripped
    "*": ["class", "id", "style"],
    // Anchor: only http/https hrefs
    a: ["href", "target", "rel"],
  },

  allowedStyles: {
    "*": Object.fromEntries(
      ALLOWED_CSS_PROPS.map((prop) => [
        prop,
        // Allow any CSS value that doesn't contain url() or expression()
        [/^(?!.*(?:url\(|expression\(|@import)).*$/i],
      ]),
    ),
  },

  allowedSchemes: ["http", "https", "mailto"],

  // Disallow all event handlers (on*)
  allowedSchemesAppliedToAttributes: ["href"],

  // strip unknown tags entirely (don't escape them as text)
  disallowedTagsMode: "discard",

  // strip <script>, <iframe>, <object>, <embed>, <form>, <input>, <button>
  // These are not in allowedTags so they are discarded by default.
};

// ---------------------------------------------------------------------------
// Exported sanitizer
// ---------------------------------------------------------------------------

/**
 * Sanitize raw HTML from user input.
 * Returns safe HTML suitable for storing and serving to agents.
 */
export function sanitizeBody(raw: string): string {
  return sanitizeHtml(raw, OPTIONS);
}
