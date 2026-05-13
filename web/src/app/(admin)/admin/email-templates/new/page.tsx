// N02 — New email template page (create mode).
// URL: /admin/email-templates/new

import { EmailTemplateForm } from "@/components/email-templates/EmailTemplateForm";

export const metadata = { title: "New Email Template · vici2 Admin" };

export default function NewEmailTemplatePage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <a
          href="/admin/email-templates"
          className="text-sm text-[var(--color-brand-600)] hover:underline"
        >
          ← Back to Email Templates
        </a>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--color-fg)]">New Email Template</h1>
      </div>
      <EmailTemplateForm mode="create" />
    </main>
  );
}
