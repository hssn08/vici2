// N02 — Edit email template page.
// URL: /admin/email-templates/[id]

import { EmailTemplateForm } from "@/components/email-templates/EmailTemplateForm";

export const metadata = { title: "Edit Email Template · vici2 Admin" };

interface PageProps {
  params: { id: string };
}

export default function EditEmailTemplatePage({ params }: PageProps): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <a
          href="/admin/email-templates"
          className="text-sm text-[var(--color-brand-600)] hover:underline"
        >
          ← Back to Email Templates
        </a>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--color-fg)]">Edit Email Template</h1>
      </div>
      <EmailTemplateForm mode="edit" templateId={params.id} />
    </main>
  );
}
