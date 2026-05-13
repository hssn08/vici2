"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type ToastTone = "neutral" | "success" | "warning" | "danger";
export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  duration?: number;
}

interface ToasterContextValue {
  toast: (t: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
}

const ToasterContext = React.createContext<ToasterContextValue | null>(null);

export function useToast(): ToasterContextValue {
  const ctx = React.useContext(ToasterContext);
  if (!ctx) throw new Error("useToast must be used within <Toaster/>");
  return ctx;
}

export function Toaster({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (t: Omit<Toast, "id">) => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { ...t, id }]);
      const duration = t.duration ?? 4_000;
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss],
  );

  return (
    <ToasterContext.Provider value={{ toast, dismiss }}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "danger" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto w-full max-w-sm rounded-md border bg-[var(--color-surface-elevated)] p-3 shadow-lg",
              t.tone === "success" && "border-emerald-500",
              t.tone === "warning" && "border-amber-500",
              t.tone === "danger" && "border-red-500",
            )}
          >
            <div className="text-sm font-semibold">{t.title}</div>
            {t.description ? (
              <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
                {t.description}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </ToasterContext.Provider>
  );
}
