/**
 * AutoDialLayout — minimal wrapper; inherits (agent) layout.
 * No extra providers needed — AgentShell already wraps SipProvider.
 */
export default function AutoDialLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <>{children}</>;
}
