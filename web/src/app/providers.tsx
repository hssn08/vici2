"use client";

import * as React from "react";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { Toaster } from "@/components/ui/toast";
import { AuthRefreshScheduler } from "@/components/providers/AuthRefreshScheduler";
import { HotkeyProvider } from "@/components/providers/HotkeyProvider";

export function Providers({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ThemeProvider>
      <Toaster>
        <HotkeyProvider>
          <AuthRefreshScheduler />
          {children}
        </HotkeyProvider>
      </Toaster>
    </ThemeProvider>
  );
}
