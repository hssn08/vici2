import type { ReactNode } from "react";

export default function SupLayout({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return <div className="min-h-screen">{children}</div>;
}
