import { describe, it, expect } from 'vitest';
import { maskJobData, maskAndTruncate, REDACTED } from '../lib/mask-job-data.js';

describe('maskJobData', () => {
  it('redacts NANP phone numbers', () => {
    const { masked } = maskJobData({ phone: '555-867-5309' });
    expect((masked as Record<string, unknown>).phone).toBe(REDACTED);
  });

  it('redacts +1 formatted phone numbers', () => {
    const { masked } = maskJobData({ contact: '+1 (555) 867-5309' });
    expect((masked as Record<string, unknown>).contact).toBe(REDACTED);
  });

  it('redacts email addresses', () => {
    const { masked } = maskJobData({ email: 'user@example.com' });
    expect((masked as Record<string, unknown>).email).toBe(REDACTED);
  });

  it('redacts PII key names regardless of value type', () => {
    const { masked } = maskJobData({ ssn: '123-45-6789', dob: '1990-01-01', credit_card: '4111111111111111' });
    const r = masked as Record<string, unknown>;
    expect(r.ssn).toBe(REDACTED);
    expect(r.dob).toBe(REDACTED);
    expect(r.credit_card).toBe(REDACTED);
  });

  it('redacts case-insensitive PII keys', () => {
    const { masked } = maskJobData({ SSN: 'value', Date_Of_Birth: 'value' });
    const r = masked as Record<string, unknown>;
    expect(r.SSN).toBe(REDACTED);
    expect(r.Date_Of_Birth).toBe(REDACTED);
  });

  it('traverses nested objects', () => {
    const { masked } = maskJobData({ lead: { phone: '555-867-5309', name: 'John' } });
    const r = masked as Record<string, unknown>;
    const lead = r.lead as Record<string, unknown>;
    expect(lead.phone).toBe(REDACTED);
    expect(lead.name).toBe('John');
  });

  it('traverses arrays', () => {
    const { masked } = maskJobData({ emails: ['a@b.com', 'c@d.com'] });
    const r = masked as Record<string, unknown>;
    const emails = r.emails as string[];
    expect(emails[0]).toBe(REDACTED);
    expect(emails[1]).toBe(REDACTED);
  });

  it('does not redact non-PII strings', () => {
    const { masked, redacted } = maskJobData({ name: 'John Doe', campaign: 'Q1-2026' });
    const r = masked as Record<string, unknown>;
    expect(r.name).toBe('John Doe');
    expect(r.campaign).toBe('Q1-2026');
    expect(redacted).toBe(false);
  });

  it('handles null and undefined', () => {
    const { masked } = maskJobData(null);
    expect(masked).toBeNull();
  });

  it('sets redacted=true when any field is masked', () => {
    const { redacted } = maskJobData({ phone: '555-867-5309' });
    expect(redacted).toBe(true);
  });
});

describe('maskAndTruncate', () => {
  it('returns masked data for PII', () => {
    const result = maskAndTruncate({ phone: '555-123-4567' });
    expect((result.data as Record<string, unknown>).phone).toBe(REDACTED);
    expect(result.masked).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('truncates data exceeding 64 KB', () => {
    const largeData = { payload: 'x'.repeat(70_000) };
    const result = maskAndTruncate(largeData);
    expect(result.truncated).toBe(true);
    expect((result.data as Record<string, unknown>)._truncated).toBe(true);
  });

  it('passthrough for clean data', () => {
    const data = { name: 'John', campaign: 42 };
    const result = maskAndTruncate(data);
    expect(result.masked).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.data).toEqual(data);
  });
});
