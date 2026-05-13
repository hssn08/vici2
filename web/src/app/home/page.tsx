"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/stores/auth";
import { Skeleton } from "@/components/ui/skeleton";

const ROLE_HOME: Record<string, string> = {
  agent: "/dashboard",
  admin: "/admin",
  sup: "/sup",
};

export default function HomeBouncePage(): React.ReactElement {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  React.useEffect(() => {
    if (user) router.replace(ROLE_HOME[user.role] ?? "/dashboard");
    else router.replace("/login");
  }, [user, router]);

  return (
    <main
      aria-busy="true"
      className="grid min-h-screen place-items-center p-6"
    >
      <Skeleton className="h-20 w-72" />
    </main>
  );
}
