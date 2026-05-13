"use client";

import * as React from "react";
import { useUiStore } from "@/lib/stores/ui";

export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const theme = useUiStore((s) => s.theme);

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const apply = (resolved: "light" | "dark") => {
      if (resolved === "dark") root.classList.add("dark");
      else root.classList.remove("dark");
      root.setAttribute("data-theme", resolved);
    };

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      apply(mq.matches ? "dark" : "light");
      const listener = (e: MediaQueryListEvent) =>
        apply(e.matches ? "dark" : "light");
      mq.addEventListener("change", listener);
      return () => mq.removeEventListener("change", listener);
    }
    apply(theme);
  }, [theme]);

  return <>{children}</>;
}
