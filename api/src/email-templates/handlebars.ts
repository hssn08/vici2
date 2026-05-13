// N02 — Isolated Handlebars environment.
// Uses Handlebars.create() to avoid prototype pollution between requests.

import Handlebars from 'handlebars';
import { registerHelpers } from './helpers.js';

// Singleton isolated Handlebars environment.
const hbs = Handlebars.create();
registerHelpers(hbs);

// noEscape: false (default) — {{var}} HTML-escapes all output (safe).
// Use {{{var}}} triple-stash ONLY for pre-sanitized HTML fragments (seed templates).

export { hbs };
