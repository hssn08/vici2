import Link from "next/link";

export default function NotFound(): React.ReactElement {
  return (
    <main className="grid min-h-screen place-items-center p-8 text-center">
      <div className="max-w-md">
        <h1 className="text-3xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          The page you were looking for has moved or never existed.
        </p>
        <p className="mt-6">
          <Link
            href="/"
            className="text-sm font-medium text-[var(--color-brand-600)] hover:underline"
          >
            Return home →
          </Link>
        </p>
      </div>
    </main>
  );
}
