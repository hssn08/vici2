"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/stores/auth";
import {
  refreshAccessToken,
  subscribeAuthEvents,
  type AuthEvent,
} from "@/lib/auth";

// Refresh ~60 s before expiry (per F05 §15.2) and on visibility/focus.
export function AuthRefreshScheduler(): null {
  const router = useRouter();
  const accessExp = useAuthStore((s) => s.accessExp);
  const accessToken = useAuthStore((s) => s.accessToken);

  // Proactive refresh timer.
  React.useEffect(() => {
    if (!accessExp || !accessToken) return;
    const now = Math.floor(Date.now() / 1000);
    const refreshAt = accessExp - 60;
    const delayMs = Math.max((refreshAt - now) * 1000, 1_000);
    const timer = setTimeout(() => {
      void refreshAccessToken();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [accessExp, accessToken]);

  // Focus / visibility opportunistic refresh.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const maybeRefresh = () => {
      const { accessExp: exp, accessToken: tok } = useAuthStore.getState();
      if (!tok || !exp) return;
      const now = Math.floor(Date.now() / 1000);
      if (exp - now < 90) void refreshAccessToken();
    };
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", maybeRefresh);
    window.addEventListener("online", maybeRefresh);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", maybeRefresh);
      window.removeEventListener("online", maybeRefresh);
    };
  }, []);

  // Cross-tab logout/login.
  React.useEffect(() => {
    return subscribeAuthEvents((msg: AuthEvent) => {
      if (msg.event === "logout") {
        useAuthStore.getState().clearSession();
        router.replace("/login");
      }
    });
  }, [router]);

  return null;
}
