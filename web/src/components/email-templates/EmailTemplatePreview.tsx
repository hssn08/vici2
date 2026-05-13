"use client";

// N02 — Sandboxed iframe preview component.
// Renders compiled email HTML in a sandboxed iframe (no scripts).

import { useEffect, useRef } from "react";

interface EmailTemplatePreviewProps {
  html: string;
  missingVars?: string[];
}

export function EmailTemplatePreview({
  html,
  missingVars = [],
}: EmailTemplatePreviewProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    // Write HTML to iframe srcdoc
    iframe.srcdoc = html || "<p style='color:#6b7280;font-size:14px;padding:1rem'>Preview will appear here.</p>";
  }, [html]);

  return (
    <div>
      {missingVars.length > 0 && (
        <div className="mb-2 rounded border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
          <strong>Missing variables:</strong> {missingVars.join(", ")}
        </div>
      )}
      <div className="overflow-hidden rounded border border-[var(--color-border)]">
        <iframe
          ref={iframeRef}
          sandbox="allow-same-origin"
          title="Email preview"
          className="w-full"
          style={{ height: "500px", border: "none" }}
          // srcdoc is set via useEffect
        />
      </div>
    </div>
  );
}
