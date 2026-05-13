"use client";

import { useToast, type ToastTone } from "@/components/ui/toast";

export interface NotifyOptions {
  title: string;
  description?: string;
  duration?: number;
}

export interface NotifyFns {
  success: (opts: NotifyOptions) => string;
  warning: (opts: NotifyOptions) => string;
  danger: (opts: NotifyOptions) => string;
  info: (opts: NotifyOptions) => string;
  dismiss: (id: string) => void;
}

/**
 * Thin typed wrapper around useToast for A03+ usage.
 *
 * @example
 * const notify = useNotify();
 * notify.success({ title: 'Agent ready', description: 'State confirmed.' });
 */
export function useNotify(): NotifyFns {
  const { toast, dismiss } = useToast();

  function fire(tone: ToastTone, opts: NotifyOptions): string {
    return toast({ tone, ...opts });
  }

  return {
    success: (opts) => fire("success", opts),
    warning: (opts) => fire("warning", opts),
    danger: (opts) => fire("danger", opts),
    info: (opts) => fire("neutral", opts),
    dismiss,
  };
}
