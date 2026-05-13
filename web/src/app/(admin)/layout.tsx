import type { ReactNode } from "react";

export default function AdminLayout({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return <div className="min-h-screen">{children}</div>;
}
