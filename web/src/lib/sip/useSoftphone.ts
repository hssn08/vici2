"use client";

/**
 * A02 — useSoftphone hook (FROZEN public API).
 *
 * Returns state and commands from the SipProvider context.
 * Must be called inside a component rendered within <SipProvider>.
 *
 * Consumed by: A04 (dial), A05 (call panel), A06 (hotkeys), A07 (transfers).
 */

import * as React from "react";
import { SoftphoneContext } from "./SipProvider";
import type { SoftphoneContextValue } from "./types";

export function useSoftphone(): SoftphoneContextValue {
  const ctx = React.useContext(SoftphoneContext);
  if (!ctx) {
    throw new Error(
      "useSoftphone() must be used inside <SipProvider>. " +
        "Ensure <SipProvider> is mounted in AgentShell.",
    );
  }
  return ctx;
}
