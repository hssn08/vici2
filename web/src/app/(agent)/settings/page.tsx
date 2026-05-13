"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useUiStore } from "@/lib/stores/ui";

export default function SettingsPage(): React.ReactElement {
  const volume = useUiStore((s) => s.volume);
  const setVolume = useUiStore((s) => s.setVolume);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          Personal preferences. Persisted in this browser only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="volume">Ringtone volume ({Math.round(volume * 100)}%)</Label>
          <input
            id="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-full"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="density">Density</Label>
          <select
            id="density"
            value={density}
            onChange={(e) =>
              setDensity(e.target.value as "comfortable" | "compact")
            }
            className="h-9 rounded-md border bg-[var(--color-surface)] px-3 text-sm"
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </div>
      </CardContent>
    </Card>
  );
}
