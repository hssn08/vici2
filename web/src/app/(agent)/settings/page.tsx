"use client";

import * as React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useUiStore } from "@/lib/stores/ui";
import { DevicePicker } from "@/lib/sip/deviceUx/DevicePicker";

export default function SettingsPage(): React.ReactElement {
  const volume = useUiStore((s) => s.volume);
  const setVolume = useUiStore((s) => s.setVolume);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const dtmfMode = useUiStore((s) => s.dtmfMode);
  const setDtmfMode = useUiStore((s) => s.setDtmfMode);
  const forceTurn = useUiStore((s) => s.forceTurn);
  const setForceTurn = useUiStore((s) => s.setForceTurn);

  return (
    <div className="flex flex-col gap-6">
      {/* Audio devices */}
      <Card>
        <CardHeader>
          <CardTitle>Audio Devices</CardTitle>
          <CardDescription>
            Select the microphone and speaker used for calls.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DevicePicker />
        </CardContent>
      </Card>

      {/* General preferences */}
      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
          <CardDescription>
            Personal preferences. Persisted in this browser only.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="volume">
              Volume ({Math.round(volume * 100)}%)
            </Label>
            <input
              id="volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-full"
              aria-label="Call volume"
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
              aria-label="UI density"
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {/* Advanced */}
      <Card>
        <CardHeader>
          <CardTitle>Advanced</CardTitle>
          <CardDescription>
            Diagnostic and network settings. Change only if instructed by
            support.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dtmf-mode">DTMF mode</Label>
            <select
              id="dtmf-mode"
              value={dtmfMode}
              onChange={(e) =>
                setDtmfMode(e.target.value as "rfc2833" | "sip-info")
              }
              className="h-9 rounded-md border bg-[var(--color-surface)] px-3 text-sm"
              aria-label="DTMF signalling mode"
            >
              <option value="rfc2833">RFC 4733 / 2833 (recommended)</option>
              <option value="sip-info">SIP INFO (IVR fallback)</option>
            </select>
            <p className="text-xs text-[var(--color-fg-muted)]">
              Switch to SIP INFO only if DTMF tones are not recognised by your
              IVR.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              id="force-turn"
              type="checkbox"
              checked={forceTurn}
              onChange={(e) => setForceTurn(e.target.checked)}
              className="h-4 w-4"
              aria-label="Force TURN relay for all media"
            />
            <Label htmlFor="force-turn">
              Force TURN relay (diagnostic — use when audio fails)
            </Label>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
