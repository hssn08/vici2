// N02 — Email templates list page.
// URL: /admin/email-templates

import { Suspense } from "react";
import { EmailTemplateList } from "@/components/email-templates/EmailTemplateList";

export const metadata = { title: "Email Templates · vici2 Admin" };

export default function EmailTemplatesPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Email Templates</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Manage email notification templates with Handlebars interpolation and version history.
          </p>
        </div>
        <a
          href="/admin/email-templates/new"
          className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
        >
          New template
        </a>
      </div>

      <Suspense
        fallback={
          <div role="status" aria-label="Loading templates" className="space-y-2">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-12 rounded bg-[var(--color-surface-2)] animate-pulse" />
            ))}
          </div>
        }
      >
        <EmailTemplateList />
      </Suspense>
    </main>
  );
}
