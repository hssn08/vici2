// S03 — HTML sanitization unit tests.
//
// Run: pnpm test (vitest)
// No database required.

import { describe, it, expect } from "vitest";
import { sanitizeBody } from "../sanitize.js";

describe("sanitizeBody — strips dangerous tags", () => {
  it("removes <script> tags entirely", () => {
    const out = sanitizeBody("<p>Hello</p><script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>Hello</p>");
  });

  it("removes <iframe>", () => {
    const out = sanitizeBody('<iframe src="https://evil.com"></iframe>');
    expect(out).not.toContain("iframe");
  });

  it("removes <object>", () => {
    const out = sanitizeBody('<object data="x.swf"></object>');
    expect(out).not.toContain("object");
  });

  it("removes <embed>", () => {
    const out = sanitizeBody('<embed src="evil.swf">');
    expect(out).not.toContain("embed");
  });

  it("removes <form> and <input>", () => {
    const out = sanitizeBody('<form action="/"><input type="text"></form>');
    expect(out).not.toContain("form");
    expect(out).not.toContain("input");
  });
});

describe("sanitizeBody — strips dangerous attributes", () => {
  it("removes onerror event handler", () => {
    const out = sanitizeBody('<img onerror="alert(1)" src="x">');
    expect(out).not.toContain("onerror");
  });

  it("removes onclick event handler", () => {
    const out = sanitizeBody('<div onclick="evil()">text</div>');
    expect(out).not.toContain("onclick");
  });

  it("removes onmouseover event handler", () => {
    const out = sanitizeBody('<p onmouseover="steal()">hover</p>');
    expect(out).not.toContain("onmouseover");
  });

  it("strips javascript: href", () => {
    const out = sanitizeBody('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
  });

  it("strips data: href", () => {
    const out = sanitizeBody('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(out).not.toContain("data:");
  });
});

describe("sanitizeBody — preserves allowed tags", () => {
  it("preserves <strong>", () => {
    const out = sanitizeBody("<strong>bold</strong>");
    expect(out).toBe("<strong>bold</strong>");
  });

  it("preserves <p>", () => {
    const out = sanitizeBody("<p>paragraph</p>");
    expect(out).toBe("<p>paragraph</p>");
  });

  it("preserves <ul><li> list", () => {
    const out = sanitizeBody("<ul><li>Item 1</li><li>Item 2</li></ul>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>Item 1</li>");
  });

  it("preserves <a> with https href", () => {
    const out = sanitizeBody('<a href="https://example.com" target="_blank">link</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it("preserves <h1> through <h4>", () => {
    const out = sanitizeBody("<h1>Title</h1><h2>Sub</h2><h3>Sub2</h3><h4>Sub3</h4>");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<h2>Sub</h2>");
  });

  it("preserves <em>", () => {
    const out = sanitizeBody("<em>italic</em>");
    expect(out).toBe("<em>italic</em>");
  });

  it("preserves <blockquote>", () => {
    const out = sanitizeBody("<blockquote>Quote</blockquote>");
    expect(out).toContain("<blockquote>Quote</blockquote>");
  });

  it("preserves table structure", () => {
    const html = "<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Alice</td></tr></tbody></table>";
    const out = sanitizeBody(html);
    expect(out).toContain("<table>");
    expect(out).toContain("<th>Name</th>");
    expect(out).toContain("<td>Alice</td>");
  });
});

describe("sanitizeBody — mixed content", () => {
  it("sanitizes inline script in otherwise valid HTML", () => {
    const html = `
      <div>
        <h2>Script Title</h2>
        <p>Hello <strong>{lead.first_name}</strong></p>
        <script>evil()</script>
        <ul><li>Point 1</li></ul>
      </div>
    `;
    const out = sanitizeBody(html);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("evil()");
    expect(out).toContain("<strong>{lead.first_name}</strong>");
    expect(out).toContain("<li>Point 1</li>");
  });

  it("preserves token placeholders in safe tags", () => {
    const body = "<p>Dear {lead.first_name},</p><p>This is {campaign.name}.</p>";
    const out = sanitizeBody(body);
    expect(out).toContain("{lead.first_name}");
    expect(out).toContain("{campaign.name}");
  });
});
