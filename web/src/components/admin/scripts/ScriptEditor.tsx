"use client";

// M07 — Tiptap-based script editor with variable sidebar and version history.

import * as React from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { PlaceholderToken } from "./PlaceholderToken";
import { PlaceholderMenu } from "./PlaceholderMenu";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { CampaignSelect } from "../shared/CampaignSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScriptResponse {
  id: string;
  name: string;
  body: string;
  campaignId: string | null;
  active: boolean;
  version: number;
  variables: Array<{ name: string }>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function ToolbarButton({
  onClick,
  active,
  disabled,
  children,
  label,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      className={cn(
        "rounded p-1.5 text-sm transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]",
        active
          ? "bg-[var(--color-brand-100)] text-[var(--color-brand-700)]"
          : "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ScriptEditorProps {
  mode: "create" | "edit";
  scriptId?: string;
}

// ---------------------------------------------------------------------------
// Detect {{tokens}} in HTML
// ---------------------------------------------------------------------------

function detectTokens(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/\{\{([a-z][a-z0-9_.]*)\}\}/gi)) {
    found.add(`{{${m[1].toLowerCase()}}}`);
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScriptEditor({ mode, scriptId }: ScriptEditorProps): React.ReactElement {
  const isEdit = mode === "edit";

  const [name, setName] = React.useState("");
  const [campaignId, setCampaignId] = React.useState("");
  const [active, setActive] = React.useState(true);
  const [version, setVersion] = React.useState(1);
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(isEdit);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Start writing your script..." }),
      PlaceholderToken,
    ],
    editorProps: {
      attributes: {
        id: "script-body-editor",
        "aria-label": "Script body — supports rich text and {{variable}} tokens",
        "aria-multiline": "true",
        class: cn(
          "min-h-[400px] outline-none p-4 text-sm text-[var(--color-fg)]",
          "prose prose-sm max-w-none",
        ),
      },
    },
  });

  // Load existing script in edit mode
  React.useEffect(() => {
    if (!isEdit || !scriptId || !editor) return;

    apiFetch<ScriptResponse>(`/api/admin/scripts/${scriptId}`)
      .then((data) => {
        setName(data.name);
        setCampaignId(data.campaignId ?? "");
        setActive(data.active);
        setVersion(data.version);
        setUpdatedAt(data.updatedAt);
        editor.commands.setContent(data.body);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Failed to load script");
      })
      .finally(() => setLoading(false));
  }, [isEdit, scriptId, editor]);

  const detectedTokens = React.useMemo(() => {
    if (!editor) return [];
    return detectTokens(editor.getHTML());
  }, [editor?.state]);

  function insertToken(token: string) {
    if (!editor) return;
    editor.chain().focus().insertContent({
      type: "text",
      text: token,
      marks: [{ type: "placeholderToken", attrs: { value: token } }],
    }).run();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editor) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    const body = {
      name,
      body: editor.getHTML(),
      campaignId: campaignId || null,
      active,
    };

    try {
      if (mode === "create") {
        const created = await apiFetch<ScriptResponse>("/api/admin/scripts", {
          method: "POST",
          body,
        });
        window.location.href = `/admin/scripts/${created.id}`;
      } else {
        const updated = await apiFetch<ScriptResponse>(`/api/admin/scripts/${scriptId}`, {
          method: "PATCH",
          body,
        });
        setVersion(updated.version);
        setUpdatedAt(updated.updatedAt);
        setSuccess(`Saved as version ${updated.version}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save script");
    } finally {
      setSaving(false);
    }
  }

  function handleRestored(newVersion: number, restoredBody: string) {
    setVersion(newVersion);
    if (restoredBody && editor) {
      editor.commands.setContent(restoredBody);
    }
    setSuccess(`Restored to v${newVersion - 1}. Saved as v${newVersion}.`);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]" />
        ))}
        <div className="h-64 animate-pulse rounded-md bg-[var(--color-surface-muted)]" />
      </div>
    );
  }

  return (
    <form onSubmit={(e: React.FormEvent<HTMLFormElement>) => void handleSubmit(e)} className="space-y-6">
      {/* Metadata row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-1">
          <label htmlFor="script-name" className="text-sm font-medium text-[var(--color-fg)]">
            Name <span aria-hidden className="text-[var(--color-state-error)]">*</span>
          </label>
          <Input
            id="script-name"
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            maxLength={64}
            required
            placeholder="e.g. Outbound Sales Script"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="script-campaign" className="text-sm font-medium text-[var(--color-fg)]">
            Campaign <span className="text-[var(--color-fg-muted)]">(optional)</span>
          </label>
          <CampaignSelect
            id="script-campaign"
            value={campaignId}
            onChange={setCampaignId}
            allowGlobal
            globalLabel="All campaigns (global)"
          />
        </div>
        <div className="flex items-end pb-0.5">
          <label className="flex items-center gap-2 text-sm font-medium text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={active}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setActive(e.target.checked)}
              className="h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-brand-600)]"
            />
            Active
          </label>
        </div>
      </div>

      {/* Banners */}
      {error && (
        <div role="alert" className="rounded-md bg-[var(--color-state-error-bg)] p-3 text-sm text-[var(--color-state-error)]">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      )}

      {/* Editor + Sidebar */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <div className="space-y-2">
          {/* Toolbar */}
          {editor && (
            <div className="flex flex-wrap items-center gap-1 rounded-t-md border border-b-0 border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-1.5">
              <ToolbarButton
                onClick={() => editor.chain().focus().toggleBold().run()}
                active={editor.isActive("bold")}
                label="Bold"
              >
                <strong>B</strong>
              </ToolbarButton>
              <ToolbarButton
                onClick={() => editor.chain().focus().toggleItalic().run()}
                active={editor.isActive("italic")}
                label="Italic"
              >
                <em>I</em>
              </ToolbarButton>
              <ToolbarButton
                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                active={editor.isActive("heading", { level: 1 })}
                label="Heading 1"
              >
                H1
              </ToolbarButton>
              <ToolbarButton
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                active={editor.isActive("heading", { level: 2 })}
                label="Heading 2"
              >
                H2
              </ToolbarButton>
              <ToolbarButton
                onClick={() => editor.chain().focus().toggleBulletList().run()}
                active={editor.isActive("bulletList")}
                label="Bullet list"
              >
                •—
              </ToolbarButton>
              <ToolbarButton
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                active={editor.isActive("orderedList")}
                label="Ordered list"
              >
                1.
              </ToolbarButton>
              <ToolbarButton
                onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                active={editor.isActive("codeBlock")}
                label="Code block"
              >
                {"</>"}
              </ToolbarButton>
              <div className="mx-1 h-4 border-l border-[var(--color-border)]" aria-hidden />
              <ToolbarButton
                onClick={() => editor.chain().focus().undo().run()}
                disabled={!editor.can().undo()}
                label="Undo"
              >
                ↩
              </ToolbarButton>
              <ToolbarButton
                onClick={() => editor.chain().focus().redo().run()}
                disabled={!editor.can().redo()}
                label="Redo"
              >
                ↪
              </ToolbarButton>
            </div>
          )}

          {/* Editor content */}
          <div className="rounded-b-md border border-[var(--color-border)] bg-[var(--color-surface)]">
            <EditorContent editor={editor} />
          </div>

          {/* Status bar */}
          <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
            <span>
              {isEdit && updatedAt && (
                <>v{version} · Updated {new Date(updatedAt).toLocaleString()}</>
              )}
            </span>
            {isEdit && scriptId && (
              <a
                href={`/admin/scripts/${scriptId}/preview`}
                className="text-[var(--color-brand-600)] hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                Open preview
              </a>
            )}
          </div>
        </div>

        {/* Variable sidebar */}
        <PlaceholderMenu onInsert={insertToken} detectedTokens={detectedTokens} />
      </div>

      {/* Save actions */}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving || !name.trim()}>
          {saving ? "Saving..." : mode === "create" ? "Create script" : "Save changes"}
        </Button>
        <a href="/admin/scripts" className="text-sm text-[var(--color-fg-muted)] hover:underline">
          Cancel
        </a>
      </div>

      {/* Version history (edit mode only) */}
      {isEdit && scriptId && (
        <VersionHistoryPanel
          scriptId={scriptId}
          currentVersion={version}
          onRestored={handleRestored}
        />
      )}
    </form>
  );
}
