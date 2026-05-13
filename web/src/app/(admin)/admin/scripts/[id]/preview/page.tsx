// S03 — Admin script preview page.
// URL: /admin/scripts/[id]/preview

import { ScriptPreview } from "@/components/admin/ScriptPreview";

export const metadata = { title: "Preview Script · vici2 Admin" };

export default function PreviewScriptPage({
  params,
}: {
  params: { id: string };
}): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <nav className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)] mb-2">
          <a href="/admin/scripts" className="hover:text-[var(--color-fg)]">
            Scripts
          </a>
          <span>/</span>
          <a href={`/admin/scripts/${params.id}`} className="hover:text-[var(--color-fg)]">
            Edit
          </a>
          <span>/</span>
          <span className="text-[var(--color-fg)]">Preview</span>
        </nav>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Script preview</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Fill in sample lead data to preview the rendered script.
        </p>
      </div>
      <ScriptPreview scriptId={params.id} />
    </main>
  );
}
