"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";
import { apiFetch } from "@/lib/api";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

const DEBOUNCE_MS = 2000;
const MAX_LENGTH = 4096;

export interface UseNotesSaveReturn {
  notes: string;
  saveStatus: SaveStatus;
  handleChange: (text: string) => void;
  handleBlur: () => void;
}

export function useNotesSave(): UseNotesSaveReturn {
  const callUuid = useCallStore((s) => s.callUuid);
  const notes = useCallStore((s) => s.notes);
  const setNotes = useCallStore((s) => s.setNotes);

  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>("idle");
  const debounceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = React.useRef<string>("");

  const saveNow = React.useCallback(
    async (text: string) => {
      if (!callUuid || text === lastSaved.current) return;
      setSaveStatus("saving");
      try {
        await apiFetch(`/api/agent/call/${callUuid}/notes`, {
          method: "PATCH",
          body: { comments: text },
        });
        lastSaved.current = text;
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch {
        setSaveStatus("error");
      }
    },
    [callUuid],
  );

  const handleChange = React.useCallback(
    (text: string) => {
      const capped = text.slice(0, MAX_LENGTH);
      setNotes(capped);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => void saveNow(capped), DEBOUNCE_MS);
    },
    [setNotes, saveNow],
  );

  const handleBlur = React.useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    void saveNow(notes);
  }, [saveNow, notes]);

  // sendBeacon on unload
  React.useEffect(() => {
    const onUnload = () => {
      if (!callUuid || notes === lastSaved.current) return;
      const body = JSON.stringify({ comments: notes });
      navigator.sendBeacon(`/api/agent/call/${callUuid}/notes`, body);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [callUuid, notes]);

  return { notes, saveStatus, handleChange, handleBlur };
}
