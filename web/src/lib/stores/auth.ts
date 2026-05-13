"use client";

import { create } from "zustand";

export type Role = "agent" | "admin" | "sup";
export type AuthStatus =
  | "unauthenticated"
  | "authenticated"
  | "refreshing"
  | "logging-out";

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  tenantId: number;
  displayName: string;
}

export interface SipCreds {
  wsUri: string;
  sipUri: string;
  authUser: string;
  authPass: string;
  domain?: string;
  iceServers?: RTCIceServer[];
}

export interface AuthState {
  accessToken: string | null;
  accessExp: number | null;
  wsToken: string | null;
  user: SessionUser | null;
  sipCreds: SipCreds | null;
  status: AuthStatus;
  lastError: { code: string; message: string } | null;

  setSession: (payload: {
    accessToken: string;
    accessExp: number;
    wsToken?: string;
    user: SessionUser;
    sipCreds?: SipCreds | null;
  }) => void;
  setRefreshing: (refreshing: boolean) => void;
  setError: (err: { code: string; message: string } | null) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  accessExp: null,
  wsToken: null,
  user: null,
  sipCreds: null,
  status: "unauthenticated",
  lastError: null,

  setSession: (payload) =>
    set({
      accessToken: payload.accessToken,
      accessExp: payload.accessExp,
      wsToken: payload.wsToken ?? null,
      user: payload.user,
      sipCreds: payload.sipCreds ?? null,
      status: "authenticated",
      lastError: null,
    }),

  setRefreshing: (refreshing) =>
    set((s) => ({
      status: refreshing
        ? "refreshing"
        : s.accessToken
          ? "authenticated"
          : "unauthenticated",
    })),

  setError: (err) => set({ lastError: err }),

  clearSession: () =>
    set({
      accessToken: null,
      accessExp: null,
      wsToken: null,
      user: null,
      sipCreds: null,
      status: "unauthenticated",
      lastError: null,
    }),
}));
