"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/auth";

export function LogoutButton(): React.ReactElement {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const onClick = async () => {
    setPending(true);
    try {
      await logout();
    } finally {
      router.replace("/login");
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      loading={pending}
      aria-label="Sign out"
    >
      Sign out
    </Button>
  );
}
