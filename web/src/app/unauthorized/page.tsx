import Link from "next/link";

export const metadata = { title: "Unauthorized" };

export default function UnauthorizedPage(): React.ReactElement {
  return (
    <main className="grid min-h-screen place-items-center p-8 text-center">
      <div className="max-w-md">
        <h1 className="text-3xl font-semibold">Unauthorized</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          You don&apos;t have permission to view this page.
        </p>
        <p className="mt-6">
          <Link
            href="/login"
            className="text-sm font-medium text-[var(--color-brand-600)] hover:underline"
          >
            Sign in with a different account →
          </Link>
        </p>
      </div>
    </main>
  );
}
