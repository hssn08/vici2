/**
 * A07 — Notifications filter persistence tests.
 * Verifies that filter state persists via sessionStorage and query-string building.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock apiFetch
// ---------------------------------------------------------------------------

const mockApiFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  api: {
    get: (...args: unknown[]) => mockApiFetch(...args),
    post: (...args: unknown[]) => mockApiFetch(...args),
    patch: (...args: unknown[]) => mockApiFetch(...args),
    delete: (...args: unknown[]) => mockApiFetch(...args),
  },
}));

import { useNotificationsPage, DEFAULT_FILTERS } from "@/lib/hooks/useNotificationsPage";

// ---------------------------------------------------------------------------
// Session storage helper
// ---------------------------------------------------------------------------

const STORAGE_KEY = "a07:notif-filters";

function clearStorage() {
  sessionStorage.removeItem(STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useNotificationsPage", () => {
  const mockPage = {
    items: [],
    nextCursor: null,
    unreadCount: 0,
  };

  beforeEach(() => {
    mockApiFetch.mockResolvedValue(mockPage);
    clearStorage();
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearStorage();
  });

  it("initializes with default filters", () => {
    const { result } = renderHook(() => useNotificationsPage());
    expect(result.current.filters).toEqual(DEFAULT_FILTERS);
  });

  it("persists severity filter to sessionStorage", async () => {
    const { result } = renderHook(() => useNotificationsPage());

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());

    act(() => {
      result.current.setFilters({ severity: "warning" });
    });

    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as {
      severity?: string;
    };
    expect(stored.severity).toBe("warning");
  });

  it("restores filters from sessionStorage on remount", async () => {
    // Pre-populate sessionStorage
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_FILTERS, severity: "error", readFilter: "unread" }),
    );

    const { result } = renderHook(() => useNotificationsPage());

    expect(result.current.filters.severity).toBe("error");
    expect(result.current.filters.readFilter).toBe("unread");
  });

  it("clearFilters resets to defaults and clears storage", async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_FILTERS, severity: "warning" }),
    );

    const { result } = renderHook(() => useNotificationsPage());
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());

    act(() => {
      result.current.clearFilters();
    });

    expect(result.current.filters).toEqual(DEFAULT_FILTERS);
    const stored = sessionStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(stored ?? "{}")).toEqual(DEFAULT_FILTERS);
  });

  it("includes severity in API query string when set", async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_FILTERS, severity: "warning" }),
    );

    renderHook(() => useNotificationsPage());
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());

    const calledUrl = mockApiFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("severity=warning");
  });

  it("includes readFilter in API query string when set to unread", async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_FILTERS, readFilter: "unread" }),
    );

    renderHook(() => useNotificationsPage());
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());

    const calledUrl = mockApiFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("read=false");
  });

  it("does not include read param when readFilter is all", async () => {
    renderHook(() => useNotificationsPage());
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());

    const calledUrl = mockApiFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("read=");
  });

  it("includes category in query string when set", async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_FILTERS, category: "system" }),
    );

    renderHook(() => useNotificationsPage());
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());

    const calledUrl = mockApiFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("category=system");
  });

  it("re-fetches when filters change", async () => {
    const { result } = renderHook(() => useNotificationsPage());
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());

    act(() => {
      result.current.setFilters({ severity: "error" });
    });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
  });

  it("includes dateFrom in query string when set", async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_FILTERS, dateFrom: "2026-01-01" }),
    );

    renderHook(() => useNotificationsPage());
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());

    const calledUrl = mockApiFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("dateFrom=2026-01-01");
  });
});
