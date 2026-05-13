import { describe, it, expect, vi } from "vitest";
import { createReconnectingWs } from "@/lib/ws";

describe("createReconnectingWs", () => {
  it("backoff increases up to cap", () => {
    const w = createReconnectingWs({
      url: () => "ws://x/ws",
      token: () => null,
      // @ts-expect-error stub
      webSocketImpl: vi.fn(),
    });
    expect(w._backoffFor(0)).toBeGreaterThan(0);
    expect(w._backoffFor(20)).toBeLessThanOrEqual(30_000);
  });

  it("queues commands while closed and reports queue size", () => {
    const w = createReconnectingWs({
      url: () => "ws://x/ws",
      token: () => null,
      // @ts-expect-error stub
      webSocketImpl: vi.fn(),
    });
    w.send({ op: "hello" });
    w.send({ op: "world" });
    expect(w._queueSize()).toBe(2);
  });

  it("drops oldest when queue overflows", () => {
    const w = createReconnectingWs({
      url: () => "ws://x/ws",
      token: () => null,
      maxQueueSize: 2,
      // @ts-expect-error stub
      webSocketImpl: vi.fn(),
    });
    w.send({ op: "1" });
    w.send({ op: "2" });
    w.send({ op: "3" });
    expect(w._queueSize()).toBe(2);
  });
});
