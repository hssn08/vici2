// N02 — Thin re-export shim so workers can import renderEmail without
// depending directly on the api package path.
// The worker and api share the same monorepo; the import path goes to the
// compiled api source. In test environments this is mocked.

import { hbs } from '../../../api/src/email-templates/handlebars.js';
import { sanitizeEmailHtml } from '../../../api/src/email-templates/sanitize.js';
import type { PrismaClient } from '@prisma/client';

export { TemplateNotFoundError } from '../../../api/src/email-templates/service.js';

export interface RenderEmailResult {
  subject: string;
  html: string;
  text: string;
}

// Re-export renderEmail from the api service
export { renderEmail } from '../../../api/src/email-templates/service.js';
export { hbs, sanitizeEmailHtml };
