import type { ReactNode } from "react";

export default function PublicLayout({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--color-surface)] p-6">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
