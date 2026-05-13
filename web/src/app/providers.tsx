"use client";

import * as React from "react";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { Toaster } from "@/components/ui/toast";
import { AuthRefreshScheduler } from "@/components/providers/AuthRefreshScheduler";

export function Providers({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ThemeProvider>
      <Toaster>
        <AuthRefreshScheduler />
        {children}
      </Toaster>
    </ThemeProvider>
  );
}
