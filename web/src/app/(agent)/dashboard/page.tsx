import type { Metadata } from "next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AgentStateToggle } from "@/components/call/AgentStateToggle";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage(): React.ReactElement {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Agent dashboard</h1>
      <p className="text-sm text-[var(--color-fg-muted)]">
        Welcome back. Use the controls below to set your status and start
        taking calls.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>Set yourself ready to receive calls.</CardDescription>
          </CardHeader>
          <CardContent>
            <AgentStateToggle />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Calls today</CardTitle>
            <CardDescription>Connected · 0 · Wrap · 0</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">0</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Callbacks</CardTitle>
            <CardDescription>Scheduled for you</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">—</p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
