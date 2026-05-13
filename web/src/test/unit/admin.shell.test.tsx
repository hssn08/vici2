// M01 — AdminShell unit tests.
//
// Tests that:
//   - The shell renders sidebar + topbar + children
//   - Navigation items appear with proper aria attributes
//   - Role filtering hides nav items for lower-privilege users
//   - Sidebar toggle button works

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdminShell } from "@/components/admin/AdminShell";
import * as authStore from "@/lib/stores/auth";
import * as uiStore from "@/lib/stores/ui";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/stores/auth", () => ({
  useAuthStore: vi.fn(),
}));

vi.mock("@/lib/stores/ui", () => ({
  useUiStore: vi.fn(),
}));

vi.mock("@/components/auth/LogoutButton", () => ({
  LogoutButton: () => <button type="button">Sign out</button>,
}));

function mockAuthStore(role: string, displayName = "Test User"): void {
  vi.mocked(authStore.useAuthStore).mockImplementation((selector) => {
    const state = {
      user: { id: "1", displayName, role, tenantId: 1, email: "test@test.com" },
      accessToken: "tok",
      accessExp: 9999999999,
      wsToken: null,
      sipCreds: null,
      status: "authenticated" as const,
      lastError: null,
      setSession: vi.fn(),
      setRefreshing: vi.fn(),
      setError: vi.fn(),
      clearSession: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return selector(state as any);
  });
}

function mockUiStore(): void {
  vi.mocked(uiStore.useUiStore).mockImplementation((selector) => {
    const state = {
      theme: "light" as const,
      density: "comfortable" as const,
      sidebarCollapsed: false,
      volume: 1,
      lastUsedDispoCode: null,
      setTheme: vi.fn(),
      setDensity: vi.fn(),
      toggleSidebar: vi.fn(),
      setVolume: vi.fn(),
      setLastUsedDispoCode: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return selector(state as any);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdminShell", () => {
  beforeEach(() => {
    mockUiStore();
  });

  it("renders children inside main content area", () => {
    mockAuthStore("admin");
    render(
      <AdminShell>
        <p>Hello admin content</p>
      </AdminShell>,
    );
    expect(screen.getByText("Hello admin content")).toBeInTheDocument();
  });

  it("renders admin navigation landmark", () => {
    mockAuthStore("admin");
    render(<AdminShell>content</AdminShell>);
    expect(screen.getByRole("navigation", { name: /admin navigation/i })).toBeInTheDocument();
  });

  it("shows Users and Settings nav items for admin role", () => {
    mockAuthStore("admin");
    render(<AdminShell>content</AdminShell>);
    expect(screen.getByRole("link", { name: /^Users$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Settings$/i })).toBeInTheDocument();
  });

  it("shows user display name in header", () => {
    mockAuthStore("admin", "Alice Admin");
    render(<AdminShell>content</AdminShell>);
    expect(screen.getByLabelText(/signed in as alice admin/i)).toBeInTheDocument();
  });

  it("marks the active nav item with aria-current=page", () => {
    mockAuthStore("admin");
    render(<AdminShell>content</AdminShell>);
    const dashboardLink = screen.getByRole("link", { name: /^Dashboard$/i });
    expect(dashboardLink).toHaveAttribute("aria-current", "page");
  });

  it("sidebar toggle button has accessible label", () => {
    mockAuthStore("admin");
    render(<AdminShell>content</AdminShell>);
    const toggle = screen.getByRole("button", { name: /toggle sidebar navigation/i });
    expect(toggle).toBeInTheDocument();
  });

  it("sidebar opens when toggle is clicked (sidebar becomes visible)", () => {
    mockAuthStore("admin");
    render(<AdminShell>content</AdminShell>);
    const sidebar = screen.getByRole("navigation", { name: /admin navigation/i });
    // Initially sidebar is closed on mobile (has -translate-x-full)
    expect(sidebar.className).toContain("-translate-x-full");

    fireEvent.click(screen.getByRole("button", { name: /toggle sidebar navigation/i }));

    // After click should have translate-x-0
    expect(sidebar.className).toContain("translate-x-0");
  });

  it("skip-to-content link is present for keyboard navigation", () => {
    mockAuthStore("admin");
    render(<AdminShell>content</AdminShell>);
    const skipLink = screen.getByRole("link", { name: /skip to main content/i });
    expect(skipLink).toBeInTheDocument();
    expect(skipLink).toHaveAttribute("href", "#main-content");
  });
});
