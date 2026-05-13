"use client";
// N04 — HubSpot Calling Widget iframe page
// URL: /hubspot-calling?tid={tenant_id}&token={JWT}
// This page is outside the admin auth boundary. Token auth via query param.

import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

interface WidgetState {
  status: "loading" | "ready" | "calling" | "error";
  phone?: string;
  error?: string;
}

export default function HubspotCallingPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const [state, setState] = useState<WidgetState>({ status: "loading" });
  const adapterRef = useRef<{ outgoingCall?: (opts: Record<string, unknown>) => void; callEnded?: (opts: Record<string, unknown>) => void } | null>(null);

  const tid = searchParams.get("tid");
  const token = searchParams.get("token");

  useEffect(() => {
    if (!tid || !token) {
      setState({ status: "error", error: "Missing authentication parameters" });
      return;
    }

    // Validate token expiry client-side (JWT is signed, not encrypted)
    try {
      const [, payloadB64] = token.split(".");
      const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number; aud?: string };
      if (payload.aud !== "hs-widget") {
        setState({ status: "error", error: "Invalid token audience" });
        return;
      }
      if (payload.exp && Date.now() / 1000 > payload.exp) {
        setState({ status: "error", error: "Session expired. Please reconnect." });
        return;
      }
    } catch {
      setState({ status: "error", error: "Invalid token format" });
      return;
    }

    // Initialize HubSpot Calling Extensions SDK
    // SDK is loaded via CDN or npm; for now we wire the postMessage adapter
    const handleMessage = (ev: MessageEvent) => {
      // HubSpot sends SYNC event to indicate readiness
      if (ev.data?.type === "SYNC") {
        setState({ status: "ready" });
        // Send INITIALIZED back to HubSpot parent
        ev.source?.postMessage(
          {
            type: "INITIALIZED",
            debugMode: false,
            isLoggedIn: true,
            sizeInfo: { width: 400, height: 600 },
          },
          { targetOrigin: "*" },
        );
      }
      if (ev.data?.type === "DIAL_NUMBER") {
        setState({ status: "calling", phone: ev.data.phoneNumber as string });
        void handleDial(ev.data.phoneNumber as string, ev.data.objectId as string);
      }
      if (ev.data?.type === "END_CALL") {
        setState({ status: "ready" });
      }
    };

    window.addEventListener("message", handleMessage);

    // Notify HubSpot we're ready
    if (window.parent !== window) {
      window.parent.postMessage({ type: "INITIALIZED", isLoggedIn: true }, "*");
    }

    setState({ status: "ready" });

    return () => window.removeEventListener("message", handleMessage);
  }, [tid, token]);

  const handleDial = async (phone: string, objectId: string) => {
    try {
      await fetch("/api/calls/external-dial", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          phone,
          hs_object_id: objectId,
          source: "hubspot_widget",
          tenant_id: tid,
        }),
      });

      // Notify HubSpot of outgoing call (with engagement pre-creation)
      if (window.parent !== window) {
        window.parent.postMessage(
          {
            type: "OUTGOING_CALL_STARTED",
            phoneNumber: phone,
            createEngagement: true,
          },
          "*",
        );
      }
    } catch {
      setState({ status: "error", error: "Failed to initiate call" });
    }
  };

  const handleEndCall = () => {
    if (window.parent !== window) {
      window.parent.postMessage({ type: "CALL_ENDED" }, "*");
    }
    setState({ status: "ready" });
  };

  if (state.status === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 p-6">
        <div className="text-center">
          <div className="mb-4 text-4xl">⚠️</div>
          <p className="text-sm font-medium text-gray-900">{state.error}</p>
          <p className="mt-2 text-xs text-gray-500">
            Please close this window and reconnect from HubSpot.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-200 bg-[#FF7A59] px-4 py-3">
        <div className="text-white">
          <p className="text-sm font-semibold">vici2</p>
          <p className="text-xs opacity-80">Click-to-Call</p>
        </div>
        <div className="ml-auto">
          <span
            className={`inline-flex h-2 w-2 rounded-full ${
              state.status === "calling" ? "bg-green-300 animate-pulse" : "bg-white opacity-60"
            }`}
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col items-center justify-center p-6">
        {state.status === "loading" && (
          <p className="text-sm text-gray-500">Connecting…</p>
        )}

        {state.status === "ready" && (
          <div className="text-center">
            <div className="mb-4 text-5xl">📞</div>
            <p className="text-sm text-gray-600">Ready to receive calls from HubSpot</p>
            <p className="mt-2 text-xs text-gray-400">Click a phone number in HubSpot to dial</p>
          </div>
        )}

        {state.status === "calling" && (
          <div className="text-center">
            <div className="mb-4 text-5xl animate-pulse">📞</div>
            <p className="text-sm font-medium text-gray-900">Calling {state.phone}</p>
            <button
              onClick={handleEndCall}
              className="mt-6 inline-flex items-center justify-center rounded-full bg-red-500 px-6 py-3 text-sm font-medium text-white hover:bg-red-600"
            >
              End Call
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 px-4 py-2 text-center">
        <p className="text-xs text-gray-400">Powered by vici2</p>
      </div>
    </div>
  );
}
