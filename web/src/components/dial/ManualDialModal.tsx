"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Simple E.164 validator (client-side hint only; server is authoritative)
function isE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone.trim());
}

// Format as user types: strip non-digit/+ and add + prefix
function normalizePhone(raw: string): string {
  let cleaned = raw.replace(/[^\d+]/g, "");
  if (!cleaned.startsWith("+")) cleaned = `+${cleaned}`;
  return cleaned;
}

export interface ManualDialModalProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (phone: string) => void;
}

export function ManualDialModal({
  open,
  onOpenChange,
  onSubmit,
}: ManualDialModalProps): React.ReactElement {
  const [phone, setPhone] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Focus input when modal opens
  React.useEffect(() => {
    if (open) {
      setPhone("");
      setTouched(false);
      // defer focus to after animation
      const id = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  const normalized = normalizePhone(phone);
  const valid = isE164(normalized);
  const showError = touched && phone.length > 0 && !valid;

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setPhone(e.target.value);
  }

  function handleBlur(): void {
    setTouched(true);
  }

  function handleSubmit(e?: React.FormEvent): void {
    e?.preventDefault();
    setTouched(true);
    if (!valid) {
      inputRef.current?.focus();
      return;
    }
    onSubmit(normalized);
    onOpenChange(false);
    setPhone("");
    setTouched(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-labelledby="manual-dial-title">
        <DialogHeader>
          <DialogTitle id="manual-dial-title">Manual Dial</DialogTitle>
          <DialogDescription>
            Enter an E.164 phone number (e.g.{" "}
            <span className="font-mono">+14155551234</span>).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate>
          <div className="space-y-2">
            <Label htmlFor="phone-input">Phone number</Label>
            <Input
              id="phone-input"
              ref={inputRef}
              type="tel"
              inputMode="tel"
              placeholder="+14155551234"
              value={phone}
              onChange={handleChange}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              aria-invalid={showError ? "true" : undefined}
              aria-describedby={showError ? "phone-error" : undefined}
              autoComplete="tel"
              className={cn(showError && "border-[var(--color-state-error)]")}
            />
            {showError && (
              <p
                id="phone-error"
                role="alert"
                className="text-xs text-[var(--color-state-error)]"
              >
                Phone must be E.164 format (example: +14155551234)
              </p>
            )}
          </div>

          <div className="mt-5 flex gap-3 justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Preview lead
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
