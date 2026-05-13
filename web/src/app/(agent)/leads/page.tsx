import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Leads" };

export default function LeadsPage(): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Leads</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Lead list lands with module D01.
        </p>
      </CardContent>
    </Card>
  );
}
