"use client";

// I03 — Admin voicemail box management page.
// Provides CRUD for mailbox definitions, greeting upload, and user assignment.

import React, { useCallback, useEffect, useState } from "react";

interface VoicemailBox {
  id: string;
  name: string;
  ingroupId: string | null;
  userId: string | null;
  didId: string | null;
  greetingUri: string | null;
  maxDurationSec: number;
  transcribe: boolean;
  active: boolean;
  createdAt: string;
  boxUsers: Array<{ userId: string }>;
}

interface CreateForm {
  name: string;
  ingroupId: string;
  maxDurationSec: number;
  transcribe: boolean;
}

const EMPTY_FORM: CreateForm = {
  name: "",
  ingroupId: "",
  maxDurationSec: 120,
  transcribe: false,
};

export default function VoicemailBoxesAdminPage(): React.ReactElement {
  const [boxes, setBoxes] = useState<VoicemailBox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [greetingFile, setGreetingFile] = useState<File | null>(null);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [assignUserId, setAssignUserId] = useState("");

  const fetchBoxes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/voicemail-boxes", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as VoicemailBox[];
      setBoxes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mailboxes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBoxes();
  }, [fetchBoxes]);

  async function handleCreate(): Promise<void> {
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/voicemail-boxes", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          ingroupId: form.ingroupId || null,
          maxDurationSec: form.maxDurationSec,
          transcribe: form.transcribe,
        }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setForm(EMPTY_FORM);
      setShowCreate(false);
      await fetchBoxes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(box: VoicemailBox): Promise<void> {
    try {
      const res = await fetch(`/api/admin/voicemail-boxes/${box.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !box.active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchBoxes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirm("Soft-delete this mailbox? It will no longer accept calls.")) return;
    try {
      const res = await fetch(`/api/admin/voicemail-boxes/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchBoxes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function handleGreetingUpload(id: string): Promise<void> {
    if (!greetingFile) return;
    setUploadingFor(id);
    try {
      const buf = await greetingFile.arrayBuffer();
      const res = await fetch(`/api/admin/voicemail-boxes/${id}/greeting`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": greetingFile.type || "audio/wav" },
        body: buf,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setGreetingFile(null);
      await fetchBoxes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingFor(null);
    }
  }

  async function handleGreetingDelete(id: string): Promise<void> {
    if (!confirm("Remove custom greeting? The system default will be used.")) return;
    try {
      const res = await fetch(`/api/admin/voicemail-boxes/${id}/greeting`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchBoxes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete greeting failed");
    }
  }

  async function handleAssignUser(id: string): Promise<void> {
    if (!assignUserId.trim()) return;
    try {
      const res = await fetch(`/api/admin/voicemail-boxes/${id}/users`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: assignUserId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAssignUserId("");
      await fetchBoxes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assign user failed");
    }
  }

  async function handleRemoveUser(boxId: string, userId: string): Promise<void> {
    try {
      const res = await fetch(`/api/admin/voicemail-boxes/${boxId}/users/${userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchBoxes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove user failed");
    }
  }

  return (
    <section className="flex flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Voicemail Boxes</h1>
        <button
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? "Cancel" : "+ New Mailbox"}
        </button>
      </div>

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="rounded border bg-gray-50 p-4">
          <h2 className="mb-4 font-medium">Create Voicemail Box</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Name *</label>
              <input
                type="text"
                className="w-full rounded border px-3 py-2 text-sm"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Support After-Hours"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">In-Group ID</label>
              <input
                type="text"
                className="w-full rounded border px-3 py-2 text-sm"
                value={form.ingroupId}
                onChange={(e) => setForm((f) => ({ ...f, ingroupId: e.target.value }))}
                placeholder="e.g. SUPPORT (optional)"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Max Duration (sec)</label>
              <input
                type="number"
                className="w-full rounded border px-3 py-2 text-sm"
                value={form.maxDurationSec}
                min={10}
                max={600}
                onChange={(e) =>
                  setForm((f) => ({ ...f, maxDurationSec: Number(e.target.value) }))
                }
              />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <input
                type="checkbox"
                id="transcribe"
                checked={form.transcribe}
                onChange={(e) => setForm((f) => ({ ...f, transcribe: e.target.checked }))}
              />
              <label htmlFor="transcribe" className="text-sm">
                Auto-transcribe (requires N07)
              </label>
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <button
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "Creating…" : "Create"}
            </button>
            <button
              className="rounded bg-gray-200 px-4 py-2 text-sm hover:bg-gray-300"
              onClick={() => {
                setShowCreate(false);
                setForm(EMPTY_FORM);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Box list */}
      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : boxes.length === 0 ? (
        <div className="rounded border border-dashed p-8 text-center text-gray-400">
          No voicemail boxes configured.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {boxes.map((box) => (
            <div key={box.id} className={`rounded border p-4 ${box.active ? "bg-white" : "bg-gray-50 opacity-75"}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{box.name}</span>
                    {!box.active && (
                      <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-500">
                        Inactive
                      </span>
                    )}
                    {box.transcribe && (
                      <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700">
                        Transcribe
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    ID: {box.id}
                    {box.ingroupId && ` · In-Group: ${box.ingroupId}`}
                    {` · Max: ${box.maxDurationSec}s`}
                    {` · Greeting: ${box.greetingUri ? "Custom" : "Default"}`}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded bg-gray-100 px-3 py-1 text-xs hover:bg-gray-200"
                    onClick={() => void handleToggleActive(box)}
                  >
                    {box.active ? "Deactivate" : "Activate"}
                  </button>
                  <button
                    className="rounded bg-red-100 px-3 py-1 text-xs text-red-700 hover:bg-red-200"
                    onClick={() => void handleDelete(box.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Greeting section */}
              <div className="mt-3 border-t pt-3">
                <div className="text-xs font-medium text-gray-600 mb-2">Greeting</div>
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    accept="audio/wav,audio/mpeg,audio/mp3"
                    className="text-xs"
                    onChange={(e) => setGreetingFile(e.target.files?.[0] ?? null)}
                  />
                  <button
                    className="rounded bg-blue-100 px-3 py-1 text-xs text-blue-700 hover:bg-blue-200 disabled:opacity-50"
                    disabled={!greetingFile || uploadingFor === box.id}
                    onClick={() => void handleGreetingUpload(box.id)}
                  >
                    {uploadingFor === box.id ? "Uploading…" : "Upload"}
                  </button>
                  {box.greetingUri && (
                    <button
                      className="rounded bg-red-100 px-3 py-1 text-xs text-red-700 hover:bg-red-200"
                      onClick={() => void handleGreetingDelete(box.id)}
                    >
                      Remove Custom
                    </button>
                  )}
                </div>
              </div>

              {/* User assignments */}
              <div className="mt-3 border-t pt-3">
                <div className="text-xs font-medium text-gray-600 mb-2">
                  Assigned Users ({box.boxUsers.length})
                </div>
                {box.boxUsers.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {box.boxUsers.map(({ userId }) => (
                      <div key={userId} className="flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs">
                        <span>User #{userId}</span>
                        <button
                          className="ml-1 text-red-500 hover:text-red-700"
                          onClick={() => void handleRemoveUser(box.id, userId)}
                          title="Remove user"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    className="rounded border px-2 py-1 text-xs"
                    value={assignUserId}
                    onChange={(e) => setAssignUserId(e.target.value)}
                    placeholder="User ID"
                  />
                  <button
                    className="rounded bg-green-100 px-3 py-1 text-xs text-green-700 hover:bg-green-200"
                    onClick={() => void handleAssignUser(box.id)}
                  >
                    Assign
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
