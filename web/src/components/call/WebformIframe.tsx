"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";

interface WebformMessage {
  type: "vici2:disposition" | "vici2:notes_append";
  version: number;
  payload: {
    status?: string;
    text?: string;
  };
}

export function WebformIframe(): React.ReactElement | null {
  const campaign = useCallStore((s) => s.campaign);
  const lead = useCallStore((s) => s.lead);
  const callUuid = useCallStore((s) => s.callUuid);
  const setNotes = useCallStore((s) => s.setNotes);
  const notes = useCallStore((s) => s.notes);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  const webformUrl = campaign?.webform_url;
  const allowedOrigin = React.useMemo(() => {
    if (!webformUrl) return null;
    try {
      return new URL(webformUrl).origin;
    } catch {
      return null;
    }
  }, [webformUrl]);

  // Send lead data to iframe on mount and on lead change
  React.useEffect(() => {
    if (!iframeRef.current || !lead || !allowedOrigin) return;
    const msg = {
      type: "vici2:lead",
      version: 1,
      payload: {
        lead_id: lead.id,
        first_name: lead.firstName ?? "",
        last_name: lead.lastName ?? "",
        phone_e164: lead.phoneE164,
        email: lead.email ?? "",
        address1: lead.address1 ?? "",
        city: lead.city ?? "",
        state: lead.state ?? "",
        postal_code: lead.postalCode ?? "",
        custom_data: (lead.customData as Record<string, string>) ?? {},
        call_uuid: callUuid,
      },
    };
    iframeRef.current.contentWindow?.postMessage(msg, allowedOrigin);
  }, [lead, callUuid, allowedOrigin]);

  // Listen for inbound messages from iframe
  React.useEffect(() => {
    if (!allowedOrigin) return;

    const handler = (event: MessageEvent) => {
      if (event.origin !== allowedOrigin) return;
      const msg = event.data as WebformMessage;
      if (!msg || typeof msg !== "object") return;
      if (msg.version !== 1) return;

      if (msg.type === "vici2:notes_append" && msg.payload.text) {
        setNotes(`${notes}\n${msg.payload.text}`.trim());
      }
      // vici2:disposition is handled by DispositionPicker via store
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [allowedOrigin, notes, setNotes]);

  if (!webformUrl) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-muted)]">
        No webform configured for this campaign.
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={webformUrl}
      title="Campaign webform"
      sandbox="allow-same-origin allow-scripts allow-forms"
      className="h-full w-full border-0"
      aria-label="Campaign webform"
    />
  );
}
