"use client";

/**
 * A02 — Hidden remote audio element for SIP.js.
 *
 * Placed inside SipProvider so it persists for the entire agent session.
 * The `autoplay` attribute is set; Safari may still reject play() which
 * is caught by AudioGate.
 */

import * as React from "react";

export const REMOTE_AUDIO_ID = "vici2-remote-audio";

export const AudioElement = React.forwardRef<HTMLAudioElement>(
  function AudioElement(_props, ref) {
    return (
      <audio
        id={REMOTE_AUDIO_ID}
        ref={ref}
        autoPlay
        playsInline
        // aria-hidden: this element carries no accessible content
        aria-hidden="true"
        style={{ display: "none" }}
      />
    );
  },
);

AudioElement.displayName = "AudioElement";
