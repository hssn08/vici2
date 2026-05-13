"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/stores/auth";
import { refreshAccessToken } from "@/lib/auth";
import { TopNav } from "@/components/shell/TopNav";
import { SideNav } from "@/components/shell/SideNav";
import { StatusBar } from "@/components/shell/StatusBar";
import { HotkeyHelpOverlay } from "@/components/shell/HotkeyHelpOverlay";
import { Skeleton } from "@/components/ui/skeleton";
import { SipProvider } from "@/lib/sip";
import { useAgentStateSync } from "@/lib/agent";

/** Inner shell — mounts inside SipProvider so hooks work. */
function AgentShellInner({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  // Wire WS → agent store sync (A03)
  useAgentStateSync();

  return (
    <div className="flex min-h-screen flex-col">
      <TopNav />
      <div className="flex flex-1 overflow-hidden">
        <SideNav />
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-auto bg-[var(--color-surface)] p-6"
        >
          {children}
        </main>
      </div>
      <StatusBar />
      {/* A07: F1 hotkey help overlay — mounted once, always listening */}
      <HotkeyHelpOverlay />
    </div>
  );
}

export function AgentShell({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const router = useRouter();
  const accessToken = useAuthStore((s) => s.accessToken);
  const status = useAuthStore((s) => s.status);
  const [bootstrapping, setBootstrapping] = React.useState(!accessToken);

  // If we land here without an in-memory session (deep link or refresh),
  // try a silent refresh via the httpOnly cookie before sending to /login.
  React.useEffect(() => {
    let cancelled = false;
    if (accessToken) {
      setBootstrapping(false);
      return;
    }
    (async () => {
      const refreshed = await refreshAccessToken();
      if (cancelled) return;
      if (!refreshed) {
        router.replace("/login?reason=expired");
      } else {
        setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, router]);

  if (bootstrapping || status === "refreshing") {
    return (
      <div
        className="grid min-h-screen place-items-center p-6"
        aria-busy="true"
      >
        <Skeleton className="h-32 w-72" />
      </div>
    );
  }

  return (
    <SipProvider>
      <AgentShellInner>{children}</AgentShellInner>
    </SipProvider>
  );
}
