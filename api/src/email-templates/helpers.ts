// N02 — Handlebars safe-helper implementations.
// FROZEN: only these 5 helpers are registered. No user-defined helpers.

import { format } from 'date-fns';
import { parsePhoneNumber } from 'libphonenumber-js/min';
import type Handlebars from 'handlebars';

export function registerHelpers(hbs: typeof Handlebars): void {
  hbs.registerHelper('formatDate', (iso8601: string, fmt: string) => {
    if (!iso8601) return '';
    try {
      return format(new Date(iso8601), fmt ?? 'MMMM d, yyyy h:mm a');
    } catch {
      return iso8601;
    }
  });

  hbs.registerHelper('phoneFormat', (e164: string) => {
    if (!e164) return '';
    try {
      return parsePhoneNumber(e164, 'US').formatNational();
    } catch {
      return e164;
    }
  });

  hbs.registerHelper('ifEq', function (
    this: unknown,
    a: unknown,
    b: unknown,
    opts: Handlebars.HelperOptions,
  ) {
    return a === b ? opts.fn(this) : opts.inverse(this);
  });

  hbs.registerHelper('upper', (str: unknown) =>
    typeof str === 'string' ? str.toUpperCase() : '',
  );

  hbs.registerHelper('truncate', (str: unknown, len: unknown) => {
    if (typeof str !== 'string') return '';
    const n = typeof len === 'number' ? len : Number(len);
    return str.length <= n ? str : str.slice(0, n) + '…';
  });
}
