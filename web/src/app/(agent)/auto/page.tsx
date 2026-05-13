"use client";

/**
 * AutoDialPage — entry point for (agent)/auto route.
 *
 * AC-A06-01: Redirects to /dial if campaign dial_method = 'MANUAL'.
 * Renders AutoDialShell which owns the state machine and WS subscriptions.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useCallStore } from "@/lib/stores/call";
import { AutoDialShell } from "./_components/AutoDialShell";

export default function AutoDialPage(): React.ReactElement {
  const router = useRouter();
  const campaign = useCallStore((s) => s.campaign);

  // AC-A06-01: redirect manual-dial campaigns back to /dial
  React.useEffect(() => {
    if (campaign && campaign.dial_method === "MANUAL") {
      router.replace("/dial");
    }
  }, [campaign, router]);

  return <AutoDialShell />;
}
