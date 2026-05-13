import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage(): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          Password resets are issued by your administrator. Contact your
          supervisor to begin recovery.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          href="/login"
          className="text-sm font-medium text-[var(--color-brand-600)] hover:underline"
        >
          ← Back to sign in
        </Link>
      </CardContent>
    </Card>
  );
}
