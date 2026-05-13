import "@testing-library/jest-dom/vitest";

// jsdom doesn't ship BroadcastChannel; stub a minimal version.
if (typeof globalThis.BroadcastChannel === "undefined") {
  class MockBroadcastChannel {
    constructor(public name: string) {}
    postMessage(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  }
  // @ts-expect-error injection
  globalThis.BroadcastChannel = MockBroadcastChannel;
}

// Ensure fetch exists (Node 20 ships native fetch).
if (typeof globalThis.fetch === "undefined") {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
    Promise.reject(new Error("fetch not available"))) as unknown as typeof fetch;
}
