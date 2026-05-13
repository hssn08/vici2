import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = { title: "Dial" };

export default function DialPage(): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual dial</CardTitle>
        <CardDescription>A04 fills this view with a dialpad.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Reserved slot. Implementation lands with module A04.
        </p>
      </CardContent>
    </Card>
  );
}
