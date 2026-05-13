// N02 — Handlebars render unit tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hbs } from '../handlebars.js';

// ---------------------------------------------------------------------------
// Helper tests
// ---------------------------------------------------------------------------

describe('formatDate helper', () => {
  it('formats ISO 8601 to a readable date', () => {
    const tmpl = hbs.compile('{{formatDate date "MMMM d, yyyy"}}');
    const result = tmpl({ date: '2026-05-13T10:00:00Z' });
    expect(result).toMatch(/May 13, 2026/);
  });

  it('returns empty string for falsy input', () => {
    const tmpl = hbs.compile('{{formatDate date "MMMM d, yyyy"}}');
    expect(tmpl({ date: '' })).toBe('');
    expect(tmpl({ date: null })).toBe('');
  });
});

describe('phoneFormat helper', () => {
  it('formats E.164 US number to national format', () => {
    const tmpl = hbs.compile('{{phoneFormat phone}}');
    const result = tmpl({ phone: '+15551234567' });
    expect(result).toBe('(555) 123-4567');
  });

  it('returns original string on parse failure', () => {
    const tmpl = hbs.compile('{{phoneFormat phone}}');
    expect(tmpl({ phone: 'not-a-phone' })).toBe('not-a-phone');
  });

  it('returns empty string for falsy input', () => {
    const tmpl = hbs.compile('{{phoneFormat phone}}');
    expect(tmpl({ phone: '' })).toBe('');
  });
});

describe('ifEq helper', () => {
  it('renders truthy branch when values are equal', () => {
    const tmpl = hbs.compile('{{#ifEq a b}}yes{{else}}no{{/ifEq}}');
    expect(tmpl({ a: 'foo', b: 'foo' })).toBe('yes');
  });

  it('renders falsy branch when values differ', () => {
    const tmpl = hbs.compile('{{#ifEq a b}}yes{{else}}no{{/ifEq}}');
    expect(tmpl({ a: 'foo', b: 'bar' })).toBe('no');
  });
});

describe('upper helper', () => {
  it('uppercases a string', () => {
    const tmpl = hbs.compile('{{upper str}}');
    expect(tmpl({ str: 'hello world' })).toBe('HELLO WORLD');
  });

  it('returns empty string for non-string input', () => {
    const tmpl = hbs.compile('{{upper val}}');
    expect(tmpl({ val: 123 })).toBe('');
  });
});

describe('truncate helper', () => {
  it('returns string as-is when within length', () => {
    const tmpl = hbs.compile('{{truncate str 20}}');
    expect(tmpl({ str: 'hello' })).toBe('hello');
  });

  it('truncates with ellipsis when over length', () => {
    const tmpl = hbs.compile('{{truncate str 5}}');
    expect(tmpl({ str: 'hello world' })).toBe('hello…');
  });
});

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

describe('Handlebars template rendering', () => {
  it('renders callback_due subject', () => {
    const tmpl = hbs.compile('Action required: Callback due — {{callback.leadName}}');
    expect(tmpl({ callback: { leadName: 'John Doe' } })).toBe(
      'Action required: Callback due — John Doe',
    );
  });

  it('resolves missing vars to empty string (non-strict mode)', () => {
    const tmpl = hbs.compile('Hello {{user.name}}');
    expect(tmpl({})).toBe('Hello ');
  });

  it('HTML-escapes user input in double-stash expressions', () => {
    const tmpl = hbs.compile('{{xss}}');
    expect(tmpl({ xss: '<script>alert(1)</script>' })).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('renders import_complete vars correctly', () => {
    const tmpl = hbs.compile(
      'Import {{import.fileName}}: {{import.rowsImported}} rows imported',
    );
    const result = tmpl({
      import: { fileName: 'leads.csv', rowsImported: 1500 },
    });
    expect(result).toBe('Import leads.csv: 1500 rows imported');
  });

  it('renders drop_gate_engaged subject', () => {
    const tmpl = hbs.compile(
      'Drop gate engaged: {{dropGate.campaignName}} ({{dropGate.dropRate}}% drop rate)',
    );
    expect(tmpl({ dropGate: { campaignName: 'May Campaign', dropRate: 4.2 } })).toBe(
      'Drop gate engaged: May Campaign (4.2% drop rate)',
    );
  });
});
