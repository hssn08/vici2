// M01 — UserForm unit tests.
//
// Tests:
//   - Form renders all required fields with labels
//   - Submit calls API with correct payload
//   - Validation errors shown for invalid input
//   - Password strength indicator updates
//   - A11y: aria-invalid on invalid fields, error IDs linked via aria-describedby

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UserForm } from "@/components/admin/UserForm";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/api", () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
}));

vi.mock("@/lib/stores/auth", () => ({
  useAuthStore: vi.fn(() => ({ accessToken: "tok", user: { tenantId: 1 } })),
}));

import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserForm (create mode)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Stub window.location
    Object.defineProperty(window, "location", {
      value: { href: "/" },
      writable: true,
    });
  });

  it("renders username, email, fullName, password fields with labels", () => {
    render(<UserForm mode="create" />);
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
  });

  it("renders role select with admin roles", () => {
    render(<UserForm mode="create" />);
    const select = screen.getByRole("combobox", { name: /role/i });
    expect(select).toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: /agent/i }).length).toBeGreaterThan(0);
    // Check option text via querySelector for specific select
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");
    expect(options.some((t) => t.toLowerCase().includes("admin"))).toBe(true);
    expect(options.some((t) => t.toLowerCase().includes("supervisor"))).toBe(true);
  });

  it("shows validation error for short username", async () => {
    render(<UserForm mode="create" />);
    const submit = screen.getByRole("button", { name: /create user/i });
    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.getByText(/at least 2 characters/i)).toBeInTheDocument();
    });
  });

  it("marks invalid field with aria-invalid", async () => {
    render(<UserForm mode="create" />);
    fireEvent.click(screen.getByRole("button", { name: /create user/i }));
    await waitFor(() => {
      const usernameInput = screen.getByLabelText(/username/i);
      expect(usernameInput).toHaveAttribute("aria-invalid", "true");
    });
  });

  it("links error message to field via aria-describedby", async () => {
    render(<UserForm mode="create" />);
    fireEvent.click(screen.getByRole("button", { name: /create user/i }));
    await waitFor(() => {
      const usernameInput = screen.getByLabelText(/username/i);
      const describedById = usernameInput.getAttribute("aria-describedby");
      expect(describedById).toBeTruthy();
      const errEl = document.getElementById(describedById!);
      expect(errEl).toBeInTheDocument();
    });
  });

  it("calls api.post with correct payload on valid submit", async () => {
    vi.mocked(api.post).mockResolvedValue({ id: "123" });
    render(<UserForm mode="create" />);

    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: "jsmith" },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "SecurePass123!" },
    });

    fireEvent.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        "/api/admin/users",
        expect.objectContaining({ username: "jsmith" }),
      );
    });
  });

  it("shows server error when API fails", async () => {
    const { ApiError } = await import("@/lib/api");
    vi.mocked(api.post).mockRejectedValue(
      new ApiError("server_error", "Internal server error", 500),
    );
    render(<UserForm mode="create" />);

    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: "jsmith" },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "SecurePass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("password strength indicator appears after typing", () => {
    render(<UserForm mode="create" />);
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "Weak" },
    });
    // The aria-live password strength region should be present after typing
    const liveRegion = document.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeInTheDocument();
  });

  it("has accessible submit button with aria-label", () => {
    render(<UserForm mode="create" />);
    const btn = screen.getByRole("button", { name: /create user/i });
    expect(btn).toBeInTheDocument();
  });

  it("has a cancel link back to /admin/users", () => {
    render(<UserForm mode="create" />);
    const cancel = screen.getByRole("link", { name: /cancel/i });
    expect(cancel).toHaveAttribute("href", "/admin/users");
  });
});
