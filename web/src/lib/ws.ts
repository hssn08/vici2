"use client";

import { useWsStore } from "@/lib/stores/ws";

export type WsConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface WsCommand<T = unknown> {
  op: string;
  payload?: T;
}

export interface WsEvent<T = unknown> {
  type: string;
  seq: number;
  ts: number;
  data: T;
}

type EventHandler = (e: WsEvent) => void;

export interface ReconnectingWsOptions {
  url: () => string;
  token: () => string | null;
  pingMs?: number;
  pongDeadlineMs?: number;
  maxBackoffMs?: number;
  baseBackoffMs?: number;
  maxQueueSize?: number;
  // Allow tests to swap WebSocket impl.
  webSocketImpl?: typeof WebSocket;
}

interface ReconnectingWs {
  start: () => void;
  stop: () => void;
  send: (cmd: WsCommand) => void;
  subscribe: (eventType: string, handler: EventHandler) => () => void;
  // Test introspection
  _backoffFor: (attempt: number) => number;
  _state: () => WsConnectionState;
  _queueSize: () => number;
}

export function createReconnectingWs(
  options: ReconnectingWsOptions,
): ReconnectingWs {
  const Ws = options.webSocketImpl ?? WebSocket;
  const pingMs = options.pingMs ?? 25_000;
  const pongDeadlineMs = options.pongDeadlineMs ?? 35_000;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const baseBackoff = options.baseBackoffMs ?? 1_000;
  const maxQueue = options.maxQueueSize ?? 100;

  let socket: WebSocket | null = null;
  let state: WsConnectionState = "idle";
  let stopped = false;
  let attempt = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPongAt: number = Date.now();
  const outboundQueue: WsCommand[] = [];
  const handlers = new Map<string, Set<EventHandler>>();

  function setState(next: WsConnectionState) {
    state = next;
    useWsStore.getState().setConnection(next);
  }

  function backoffFor(att: number): number {
    const exp = Math.min(baseBackoff * Math.pow(2, att), maxBackoff);
    const jitter = exp * (0.75 + Math.random() * 0.5); // ±25 %
    return Math.min(jitter, maxBackoff);
  }

  function clearTimers() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function flushQueue() {
    while (outboundQueue.length && socket && socket.readyState === 1) {
      const cmd = outboundQueue.shift();
      if (!cmd) break;
      try {
        socket.send(JSON.stringify(cmd));
      } catch {
        // requeue and bail
        outboundQueue.unshift(cmd);
        break;
      }
    }
    useWsStore.getState().noteOutboundSize(outboundQueue.length);
  }

  function enqueue(cmd: WsCommand) {
    if (outboundQueue.length >= maxQueue) {
      outboundQueue.shift(); // drop oldest
    }
    outboundQueue.push(cmd);
    useWsStore.getState().noteOutboundSize(outboundQueue.length);
  }

  function send(cmd: WsCommand) {
    if (socket && socket.readyState === 1) {
      try {
        socket.send(JSON.stringify(cmd));
        return;
      } catch {
        /* fall through to enqueue */
      }
    }
    enqueue(cmd);
  }

  function startHeartbeat() {
    lastPongAt = Date.now();
    pingTimer = setInterval(() => {
      send({ op: "ping" });
    }, pingMs);
    watchdogTimer = setInterval(() => {
      if (Date.now() - lastPongAt > pongDeadlineMs) {
        // missed pong → force reconnect
        if (socket && socket.readyState === 1) {
          try {
            socket.close(4000, "pong-timeout");
          } catch {
            /* ignore */
          }
        }
      }
    }, 5_000);
  }

  function open() {
    if (stopped) return;
    const baseUrl = options.url();
    const token = options.token();
    const url = token
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
      : baseUrl;
    setState(attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new Ws(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      attempt = 0;
      setState("open");
      const lastSeq = useWsStore.getState().lastSeq;
      if (lastSeq > 0) send({ op: "resume", payload: { from: lastSeq } });
      startHeartbeat();
      flushQueue();
    });

    ws.addEventListener("message", (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const env = parsed as Partial<WsEvent> & { op?: string };
      if (env.op === "pong") {
        lastPongAt = Date.now();
        useWsStore.getState().notePong(lastPongAt);
        return;
      }
      if (typeof env.type !== "string") return;
      const event = {
        type: env.type,
        seq: typeof env.seq === "number" ? env.seq : 0,
        ts: typeof env.ts === "number" ? env.ts : Date.now(),
        data: env.data,
      } as WsEvent;
      if (event.seq > 0) useWsStore.getState().noteSeq(event.seq);
      const hs = handlers.get(event.type);
      if (hs) hs.forEach((h) => h(event));
      const wildcards = handlers.get("*");
      if (wildcards) wildcards.forEach((h) => h(event));
    });

    ws.addEventListener("close", () => {
      clearTimers();
      socket = null;
      if (stopped) {
        setState("closed");
        return;
      }
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close will follow
    });
  }

  function scheduleReconnect() {
    const delay = backoffFor(attempt++);
    setState("reconnecting");
    reconnectTimer = setTimeout(() => {
      open();
    }, delay);
  }

  return {
    start: () => {
      stopped = false;
      open();
    },
    stop: () => {
      stopped = true;
      clearTimers();
      if (socket) {
        try {
          socket.close(1000, "client-stop");
        } catch {
          /* ignore */
        }
        socket = null;
      }
      setState("closed");
    },
    send,
    subscribe: (eventType, handler) => {
      let set = handlers.get(eventType);
      if (!set) {
        set = new Set();
        handlers.set(eventType, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    _backoffFor: backoffFor,
    _state: () => state,
    _queueSize: () => outboundQueue.length,
  };
}
