"use client";

import { z } from "zod";
import { env } from "@/lib/env";
import {
  useAuthStore,
  type Role,
  type SessionUser,
  type SipCreds,
} from "@/lib/stores/auth";

// ------- response schemas (per F05 §15.2) ------------------------------------

const SipCredsSchema = z
  .object({
    wsUri: z.string().optional(),
    ws_uri: z.string().optional(),
    sipUri: z.string().optional(),
    sip_uri: z.string().optional(),
    authUser: z.string().optional(),
    username: z.string().optional(),
    authPass: z.string().optional(),
    password: z.string().optional(),
    domain: z.string().optional(),
    iceServers: z.array(z.any()).optional(),
  })
  .partial();

const UserSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  email: z.string(),
  role: z.enum(["agent", "admin", "sup"]),
  tenantId: z.number().optional(),
  tenant_id: z.number().optional(),
  displayName: z.string().optional(),
  display_name: z.string().optional(),
});

const LoginResponseSchema = z.object({
  access_token: z.string(),
  access_exp: z.number().optional(),
  ws_token: z.string().optional(),
  ws_exp: z.number().optional(),
  user: UserSchema,
  sip_creds: SipCredsSchema.optional().nullable(),
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

const RefreshResponseSchema = z.object({
  access_token: z.string(),
  access_exp: z.number().optional(),
  ws_token: z.string().optional(),
  ws_exp: z.number().optional(),
});

export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

// ------- helpers -------------------------------------------------------------

function normalizeUser(u: z.infer<typeof UserSchema>): SessionUser {
  return {
    id: u.id,
    email: u.email,
    role: u.role as Role,
    tenantId: u.tenantId ?? u.tenant_id ?? 0,
    displayName: u.displayName ?? u.display_name ?? u.email,
  };
}

function normalizeSipCreds(
  c: z.infer<typeof SipCredsSchema> | null | undefined,
): SipCreds | null {
  if (!c) return null;
  const wsUri = c.wsUri ?? c.ws_uri;
  const authUser = c.authUser ?? c.username;
  const authPass = c.authPass ?? c.password;
  if (!wsUri || !authUser || !authPass) return null;
  return {
    wsUri,
    sipUri: c.sipUri ?? c.sip_uri ?? `sip:${authUser}@${c.domain ?? "vici2"}`,
    authUser,
    authPass,
    domain: c.domain,
    iceServers: c.iceServers as RTCIceServer[] | undefined,
  };
}

function jwtExp(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof json.exp === "number") return json.exp;
    return null;
  } catch {
    return null;
  }
}

// ------- public API ----------------------------------------------------------

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function login(
  email: string,
  password: string,
): Promise<SessionUser> {
  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    throw new AuthError(
      body.code ?? "auth.login.failed",
      body.message ?? `Login failed (${res.status})`,
      res.status,
    );
  }

  const json = (await res.json()) as unknown;
  const parsed = LoginResponseSchema.parse(json);
  const user = normalizeUser(parsed.user);
  const sipCreds = normalizeSipCreds(parsed.sip_creds);
  const exp = parsed.access_exp ?? jwtExp(parsed.access_token) ?? 0;

  useAuthStore.getState().setSession({
    accessToken: parsed.access_token,
    accessExp: exp,
    wsToken: parsed.ws_token,
    user,
    sipCreds,
  });

  broadcastAuth({ event: "login", userId: user.id });
  return user;
}

export async function logout(): Promise<void> {
  useAuthStore.getState().setRefreshing(false);
  try {
    await fetch(`${env.NEXT_PUBLIC_API_URL}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    /* network error during logout is non-fatal */
  } finally {
    useAuthStore.getState().clearSession();
    broadcastAuth({ event: "logout" });
  }
}

// Single-flight refresh: concurrent callers share one in-flight promise.
let refreshInFlight: Promise<RefreshResponse | null> | null = null;

export function refreshAccessToken(): Promise<RefreshResponse | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    useAuthStore.getState().setRefreshing(true);
    try {
      const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        useAuthStore.getState().clearSession();
        return null;
      }
      const body = (await res.json()) as unknown;
      const parsed = RefreshResponseSchema.parse(body);
      const exp = parsed.access_exp ?? jwtExp(parsed.access_token) ?? 0;
      const s = useAuthStore.getState();
      if (s.user) {
        s.setSession({
          accessToken: parsed.access_token,
          accessExp: exp,
          wsToken: parsed.ws_token ?? s.wsToken ?? undefined,
          user: s.user,
          sipCreds: s.sipCreds,
        });
      } else {
        // No user in memory; cookie-based session bootstrap path.
        useAuthStore.setState({
          accessToken: parsed.access_token,
          accessExp: exp,
          wsToken: parsed.ws_token ?? null,
        });
      }
      return parsed;
    } catch {
      useAuthStore.getState().clearSession();
      return null;
    } finally {
      useAuthStore.getState().setRefreshing(false);
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// ------- tab sync via BroadcastChannel (graceful fallback) -------------------

export type AuthEvent =
  | { event: "login"; userId: string }
  | { event: "logout" };

const CHANNEL_NAME = "vici2.auth";

function broadcastAuth(msg: AuthEvent): void {
  if (typeof window === "undefined") return;
  try {
    const ch = getChannel();
    ch?.postMessage(msg);
  } catch {
    /* ignore */
  }
}

let _channel: BroadcastChannel | null | undefined;
function getChannel(): BroadcastChannel | null {
  if (_channel !== undefined) return _channel;
  if (typeof BroadcastChannel === "undefined") {
    _channel = null;
    return null;
  }
  _channel = new BroadcastChannel(CHANNEL_NAME);
  return _channel;
}

export function subscribeAuthEvents(
  handler: (msg: AuthEvent) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const ch = getChannel();
  if (!ch) return () => undefined;
  const listener = (ev: MessageEvent<AuthEvent>) => handler(ev.data);
  ch.addEventListener("message", listener);
  return () => ch.removeEventListener("message", listener);
}

// expose for tests
export const _internal = {
  jwtExp,
  normalizeUser,
  normalizeSipCreds,
  resetRefreshState: () => {
    refreshInFlight = null;
  },
};
