"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "h-9 w-full rounded-md border bg-[var(--color-surface)] px-3 py-1 text-sm shadow-sm transition-colors",
        "placeholder:text-[var(--color-fg-muted)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "aria-[invalid=true]:border-[var(--color-state-error)]",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
