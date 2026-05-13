"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { login, AuthError } from "@/lib/auth";

const LoginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type LoginValues = z.infer<typeof LoginSchema>;
type FieldErrors = Partial<Record<keyof LoginValues, string>>;

const ROLE_HOME: Record<string, string> = {
  agent: "/dashboard",
  admin: "/admin",
  sup: "/sup",
};

export function LoginForm(): React.ReactElement {
  const router = useRouter();
  const search = useSearchParams();
  const next = search?.get("next") ?? null;
  const reason = search?.get("reason") ?? null;

  const [values, setValues] = React.useState<LoginValues>({
    email: "",
    password: "",
  });
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(
    reason === "expired"
      ? "Your session expired. Please sign in again."
      : null,
  );
  const [submitting, setSubmitting] = React.useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setErrors({});
    const parsed = LoginSchema.safeParse(values);
    if (!parsed.success) {
      const fe: FieldErrors = {};
      parsed.error.issues.forEach((issue) => {
        const k = issue.path[0] as keyof LoginValues;
        if (k && !fe[k]) fe[k] = issue.message;
      });
      setErrors(fe);
      return;
    }
    setSubmitting(true);
    try {
      const user = await login(parsed.data.email, parsed.data.password);
      const dest = next ?? ROLE_HOME[user.role] ?? "/home";
      router.replace(dest);
    } catch (err) {
      if (err instanceof AuthError) {
        setFormError(err.message);
      } else {
        setFormError("Unable to sign in. Try again in a moment.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate aria-describedby="login-error">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            value={values.email}
            onChange={(e) =>
              setValues((v) => ({ ...v, email: e.target.value }))
            }
            disabled={submitting}
          />
          {errors.email ? (
            <p
              id="email-error"
              className="text-xs text-[var(--color-state-error)]"
            >
              {errors.email}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? "password-error" : undefined}
            value={values.password}
            onChange={(e) =>
              setValues((v) => ({ ...v, password: e.target.value }))
            }
            disabled={submitting}
          />
          {errors.password ? (
            <p
              id="password-error"
              className="text-xs text-[var(--color-state-error)]"
            >
              {errors.password}
            </p>
          ) : null}
        </div>

        {formError ? (
          <div
            id="login-error"
            role="alert"
            className="rounded-md border border-[var(--color-state-error)] bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30"
          >
            {formError}
          </div>
        ) : null}

        <Button type="submit" loading={submitting} disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </div>
    </form>
  );
}
