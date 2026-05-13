"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CallStatePill } from "@/components/call/CallStatePill";
import { useCallStore } from "@/lib/stores/call";

export default function CallPage(): React.ReactElement {
  const phase = useCallStore((s) => s.phase);
  const lead = useCallStore((s) => s.lead);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          Active call <CallStatePill phase={phase} />
        </CardTitle>
        <CardDescription>
          A05 fills the live-call panel with controls, lead info, and audio.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {lead ? (
          <p className="text-sm">{lead.phoneE164}</p>
        ) : (
          <p className="text-sm text-[var(--color-fg-muted)]">
            No call in progress.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
