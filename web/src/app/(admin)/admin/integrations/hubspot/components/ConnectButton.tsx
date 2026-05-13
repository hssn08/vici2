"use client";
// N04 — Standalone connect button for HubSpot (for embedding in integrations hub)

interface Props {
  label?: string;
  className?: string;
}

export function ConnectButton({ label = "Connect HubSpot", className }: Props): React.ReactElement {
  return (
    <a
      href="/api/admin/integrations/hubspot/oauth/start"
      className={className ?? "inline-flex items-center justify-center rounded-md bg-[#FF7A59] px-4 py-2 text-sm font-medium text-white hover:bg-[#e8693f] transition-colors"}
    >
      {label}
    </a>
  );
}
