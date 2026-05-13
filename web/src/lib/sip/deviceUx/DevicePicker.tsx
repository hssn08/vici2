"use client";

/**
 * A02 — DevicePicker
 *
 * Mic + speaker picker for the agent settings page.
 * Safari: speaker picker is shown but disabled with a tooltip (PLAN §8.2).
 * a11y: labelled with <label>, role=combobox via <select>.
 */

import * as React from "react";
import { useSoftphone } from "../useSoftphone";

function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /Safari/i.test(navigator.userAgent) &&
    !/Chrome|Chromium|Edg/i.test(navigator.userAgent)
  );
}

export function DevicePicker(): React.ReactElement {
  const {
    audioInputs,
    audioOutputs,
    selectMic,
    selectSpeaker,
  } = useSoftphone();

  const safari = isSafari();
  const hasSinkId =
    typeof HTMLAudioElement !== "undefined" &&
    "setSinkId" in HTMLAudioElement.prototype;
  const speakerSupported = !safari && hasSinkId;

  return (
    <div className="flex flex-col gap-6">
      {/* Microphone picker */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="mic-picker"
          className="text-sm font-medium text-[var(--color-fg)]"
        >
          Microphone
        </label>
        {audioInputs.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            No microphone devices found.
          </p>
        ) : (
          <select
            id="mic-picker"
            aria-label="Select microphone"
            className="h-9 w-full rounded-md border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]"
            onChange={(e) => selectMic(e.target.value)}
          >
            {audioInputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone (${d.deviceId.slice(0, 6)}…)`}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Speaker picker */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="speaker-picker"
          className="text-sm font-medium text-[var(--color-fg)]"
        >
          Speaker
        </label>
        {!speakerSupported ? (
          <p
            className="text-sm text-[var(--color-fg-muted)]"
            title={
              safari
                ? "Safari does not support audio output selection. Use System Preferences → Sound."
                : "Your browser does not support audio output device selection."
            }
            aria-label={
              safari
                ? "Speaker selection unavailable on Safari. Use System Preferences → Sound."
                : "Speaker selection not supported in this browser."
            }
          >
            {safari
              ? "Speaker selection is not available in Safari. Use System Preferences → Sound."
              : "Speaker selection is not supported in this browser."}
          </p>
        ) : audioOutputs.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            No speaker devices found.
          </p>
        ) : (
          <select
            id="speaker-picker"
            aria-label="Select speaker"
            className="h-9 w-full rounded-md border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]"
            onChange={(e) => selectSpeaker(e.target.value)}
          >
            {audioOutputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Speaker (${d.deviceId.slice(0, 6)}…)`}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
