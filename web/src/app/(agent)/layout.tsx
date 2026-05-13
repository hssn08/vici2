import type { ReactNode } from "react";
import { AgentShell } from "./AgentShell";

export default function AgentLayout({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return <AgentShell>{children}</AgentShell>;
}
