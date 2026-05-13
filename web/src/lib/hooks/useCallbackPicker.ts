"use client";

// A08 — useCallbackPicker: form state + submit logic for CallbackPicker modal.

import { useState, useMemo, useCallback } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import {
  isOutsideTcpaWindow,
  defaultCallbackTime,
  localDateTimeToIso,
  mapApiError,
} from "@/lib/types/callbacks";
import type { Callback, TcpaResult } from "@/lib/types/callbacks";

interface UseCallbackPickerOptions {
  leadId: string;
  campaignId: string;
  leadTzIana: string | null;
  leadName: string;
  onSuccess?: (callback: Callback) => void;
}

interface UseCallbackPickerReturn {
  dateTime: string;
  setDateTime: (v: string) => void;
  scope: "me" | "anyone";
  setScope: (s: "me" | "anyone") => void;
  comments: string;
  setComments: (v: string) => void;
  tcpaWarning: boolean;
  tcpaResponse: TcpaResult | null;
  loading: boolean;
  error: string | null;
  submit: () => Promise<void>;
  reset: () => void;
}

const MIN_FUTURE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const MAX_COMMENTS = 255;

export function useCallbackPicker(
  opts: UseCallbackPickerOptions,
): UseCallbackPickerReturn {
  const { leadId, campaignId, leadTzIana, onSuccess } = opts;

  const [dateTime, setDateTime] = useState(defaultCallbackTime);
  const [scope, setScope] = useState<"me" | "anyone">("me");
  const [comments, setComments] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tcpaResponse, setTcpaResponse] = useState<TcpaResult | null>(null);

  // Synchronous TCPA warning based on selected datetime
  const tcpaWarning = useMemo(() => {
    if (!dateTime) return false;
    try {
      return isOutsideTcpaWindow(localDateTimeToIso(dateTime), leadTzIana);
    } catch {
      return false;
    }
  }, [dateTime, leadTzIana]);

  const validate = (): string | null => {
    if (!dateTime) return "Please select a date and time";

    let ms: number;
    try {
      ms = new Date(dateTime).getTime();
    } catch {
      return "Invalid date and time";
    }

    const now = Date.now();
    if (ms - now < MIN_FUTURE_MS) {
      return "Callback must be at least 5 minutes from now";
    }
    if (ms - now > MAX_FUTURE_MS) {
      return "Callback cannot be more than 1 year out";
    }
    if (comments.length > MAX_COMMENTS) {
      return `Comments must be ${MAX_COMMENTS} characters or fewer`;
    }
    return null;
  };

  const submit = useCallback(async () => {
    setError(null);
    setTcpaResponse(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    try {
      const response = await apiFetch<Callback & { tcpa_warning?: TcpaResult }>(
        "/api/agent/callbacks",
        {
          method: "POST",
          body: {
            lead_id: leadId,
            campaign_id: campaignId,
            callback_at: localDateTimeToIso(dateTime),
            agent_only: scope === "me",
            ...(comments.trim() ? { comments: comments.trim() } : {}),
          },
        },
      );

      if (response.tcpa_warning) {
        setTcpaResponse(response.tcpa_warning);
      }

      onSuccess?.(response);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? mapApiError(err.code)
          : err instanceof Error
            ? err.message
            : "Failed to schedule callback";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [leadId, campaignId, dateTime, scope, comments, onSuccess]);

  const reset = useCallback(() => {
    setDateTime(defaultCallbackTime());
    setScope("me");
    setComments("");
    setError(null);
    setTcpaResponse(null);
  }, []);

  return {
    dateTime,
    setDateTime,
    scope,
    setScope,
    comments,
    setComments,
    tcpaWarning,
    tcpaResponse,
    loading,
    error,
    submit,
    reset,
  };
}
