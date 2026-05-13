"use client";

// A08 — In-memory Zustand store for callback due-toast deduplication.
// NOT persisted (PII data — callback IDs associated with lead info).

import { create } from "zustand";

interface CallbackStore {
  /** Set of callback IDs whose due-toast has been shown in this session */
  dueShown: Set<string>;
  addDueShown: (id: string) => void;
  clearDueShown: () => void;
}

export const useCallbackStore = create<CallbackStore>((set) => ({
  dueShown: new Set<string>(),
  addDueShown: (id) =>
    set((s) => {
      const next = new Set(s.dueShown);
      next.add(id);
      return { dueShown: next };
    }),
  clearDueShown: () => set({ dueShown: new Set<string>() }),
}));
