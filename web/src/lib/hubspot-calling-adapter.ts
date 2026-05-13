// N04 — HubSpot Calling Extensions SDK adapter
// Wraps @hubspot/calling-extensions-sdk with typed callbacks.
// Installed with: pnpm add -w @hubspot/calling-extensions-sdk

export interface HubspotCallingAdapterOptions {
  tenantId: number;
  userId: number;
  onDialNumber: (phoneNumber: string, objectId: string) => void;
  onEndCall: () => void;
  onEngagementCreated?: (engagementId: string) => void;
}

export interface IHubspotCallingAdapter {
  outgoingCall(opts: { phoneNumber: string; createEngagement: boolean; fromNumber?: string }): void;
  callAnswered(opts: { externalCallId: string }): void;
  callEnded(opts: { externalCallId: string; engagementId?: string }): void;
  callCompleted(opts: { engagementId?: string; hideWidget?: boolean }): void;
  sendError(opts: { message: string }): void;
  destroy(): void;
}

/**
 * Create a HubSpot Calling Extensions adapter.
 * Uses dynamic import to avoid SSR issues (SDK uses window.postMessage).
 */
export async function createHubspotCallingAdapter(
  opts: HubspotCallingAdapterOptions,
): Promise<IHubspotCallingAdapter> {
  // Dynamic import — SDK is browser-only
  const { default: CallingExtensions } = await import(
    /* webpackChunkName: "hubspot-sdk" */
    "@hubspot/calling-extensions-sdk"
  );

  let storedEngagementId: string | undefined;

  const extensions = new CallingExtensions({
    debugMode: process.env.NODE_ENV === "development",
    eventHandlers: {
      onReady: () => {
        extensions.initialized({ isLoggedIn: true });
      },
      onDialNumber: ({ phoneNumber, objectId }: { phoneNumber: string; objectId: string | number }) => {
        opts.onDialNumber(phoneNumber, String(objectId));
      },
      onCreateEngagementSucceeded: ({ engagementId }: { engagementId: string }) => {
        storedEngagementId = engagementId;
        opts.onEngagementCreated?.(engagementId);
      },
      onCreateEngagementFailed: () => {
        // Will fall back to POST-call engagement creation in the push worker
      },
      onEndCall: opts.onEndCall,
      onVisibilityChanged: ({ isMinimized }: { isMinimized: boolean }) => {
        void isMinimized; // Used for UI layout adjustments
      },
    },
  });

  return {
    outgoingCall(opts: { phoneNumber: string; createEngagement: boolean; fromNumber?: string }) {
      extensions.outgoingCall(opts);
    },
    callAnswered(opts: { externalCallId: string }) {
      extensions.callAnswered(opts);
    },
    callEnded(opts: { externalCallId: string; engagementId?: string }) {
      extensions.callEnded({ ...opts, engagementId: opts.engagementId ?? storedEngagementId });
    },
    callCompleted(opts: { engagementId?: string; hideWidget?: boolean }) {
      extensions.callCompleted(opts);
    },
    sendError(opts: { message: string }) {
      extensions.sendError(opts);
    },
    destroy() {
      // SDK does not expose a destroy method; no-op for cleanup interface
    },
  };
}
