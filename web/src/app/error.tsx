"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    console.error("[web/error]", error);
  }, [error]);

  return (
    <main
      role="alert"
      className="grid min-h-screen place-items-center p-8 text-center"
    >
      <div className="max-w-md">
        <h1 className="text-3xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          An unexpected error occurred. You can try reloading the section, or
          return to the home page.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-[var(--color-fg-muted)]">
            ref: {error.digest}
          </p>
        ) : null}
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => reset()}>Retry</Button>
          <Button variant="secondary" onClick={() => (window.location.href = "/")}>
            Go home
          </Button>
        </div>
      </div>
    </main>
  );
}
