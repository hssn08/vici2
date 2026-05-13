// M07 — Admin new script page (upgraded from S03 ScriptForm to Tiptap ScriptEditor).
// URL: /admin/scripts/new

import { ScriptEditorClient } from "@/components/admin/scripts/ScriptEditorClient";

export const metadata = { title: "New Script · vici2 Admin" };

export default function NewScriptPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <nav className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)] mb-2">
          <a href="/admin/scripts" className="hover:text-[var(--color-fg)]">Scripts</a>
          <span>/</span>
          <span className="text-[var(--color-fg)]">New</span>
        </nav>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">New script</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Use <code className="text-xs">{"{{lead.first_name}}"}</code> tokens for variable interpolation.
        </p>
      </div>
      <ScriptEditorClient mode="create" />
    </main>
  );
}
