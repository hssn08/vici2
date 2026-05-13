import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Callbacks" };

export default function CallbacksPage(): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Callbacks</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Callbacks list lands with module A08.
        </p>
      </CardContent>
    </Card>
  );
}
