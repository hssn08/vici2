// S02 supervisor monitor page.
// The primary entry point is the S01 wallboard (via MonitorModal embedded in
// agent tiles). This page provides a standalone route for deep-linking.
//
// S02 PLAN §9.1.

export const metadata = { title: "Supervisor Monitor" };

export default function MonitorPage(): React.ReactElement {
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">Live Monitor</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Click an agent tile on the{" "}
        <a href="/sup" className="underline">
          wallboard
        </a>{" "}
        to begin monitoring.
      </p>
    </main>
  );
}
