// S03 — Admin edit script page.
// URL: /admin/scripts/[id]

import { ScriptForm } from "@/components/admin/ScriptForm";

export const metadata = { title: "Edit Script · vici2 Admin" };

export default function EditScriptPage({
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
          <span className="text-[var(--color-fg)]">Edit</span>
        </nav>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Edit script</h1>
      </div>
      <ScriptForm mode="edit" scriptId={params.id} />
    </main>
  );
}
