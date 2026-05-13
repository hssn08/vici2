"use client";

import { env } from "@/lib/env";
import { useAuthStore } from "@/lib/stores/auth";
import { refreshAccessToken } from "@/lib/auth";

export interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  // Internal: prevent recursive 401-retry loops.
  _retried?: boolean;
}

function buildHeaders(
  base: HeadersInit | undefined,
  hasBody: boolean,
): Headers {
  const h = new Headers(base);
  const { accessToken, user } = useAuthStore.getState();
  if (accessToken && !h.has("authorization")) {
    h.set("authorization", `Bearer ${accessToken}`);
  }
  if (user?.tenantId && !h.has("x-vici2-tenant")) {
    h.set("x-vici2-tenant", String(user.tenantId));
  }
  if (hasBody && !h.has("content-type")) {
    h.set("content-type", "application/json");
  }
  return h;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { body, _retried, ...rest } = options;
  const hasBody = body !== undefined && body !== null;
  const init: RequestInit = {
    ...rest,
    credentials: "include",
    headers: buildHeaders(rest.headers, hasBody),
    body: hasBody
      ? typeof body === "string" || body instanceof FormData
        ? (body as BodyInit)
        : JSON.stringify(body)
      : undefined,
  };

  const url = path.startsWith("http")
    ? path
    : `${env.NEXT_PUBLIC_API_URL}${path}`;

  const res = await fetch(url, init);

  if (res.status === 401 && !_retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiFetch<T>(path, { ...options, _retried: true });
    }
    // refresh failed → logout cascade is triggered inside refreshAccessToken().
  }

  if (!res.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* non-json error body */
    }
    throw new ApiError(
      body.code ?? `api.${res.status}`,
      body.message ?? res.statusText,
      res.status,
      body.details,
    );
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T = unknown>(path: string, opts?: ApiRequestOptions) =>
    apiFetch<T>(path, { ...opts, method: "GET" }),
  post: <T = unknown>(path: string, body?: unknown, opts?: ApiRequestOptions) =>
    apiFetch<T>(path, { ...opts, method: "POST", body }),
  put: <T = unknown>(path: string, body?: unknown, opts?: ApiRequestOptions) =>
    apiFetch<T>(path, { ...opts, method: "PUT", body }),
  patch: <T = unknown>(
    path: string,
    body?: unknown,
    opts?: ApiRequestOptions,
  ) => apiFetch<T>(path, { ...opts, method: "PATCH", body }),
  delete: <T = unknown>(path: string, opts?: ApiRequestOptions) =>
    apiFetch<T>(path, { ...opts, method: "DELETE" }),
};
