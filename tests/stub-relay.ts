import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { NostrEvent } from "nostr-tools/core";
import { WebSocketServer, type WebSocket } from "ws";

export interface StubRelay {
  url: string;
  /** Every EVENT the stub received, in arrival order, retries included. */
  received: NostrEvent[];
  /** How many clients connected. */
  connections: number;
  close(): Promise<void>;
}

export interface StubContext {
  /** Sends `["OK", <event id>, ok, message]` back to the client. */
  reply(ok: boolean, message: string): void;
  socket: WebSocket;
  /** 1 for the first EVENT the stub received, 2 for the second, and so on. */
  n: number;
}

export interface StubReqContext {
  /** Sends `["EVENT", <sub id>, ev]`. */
  send(ev: NostrEvent): void;
  /** Sends `["EOSE", <sub id>]`. */
  eose(): void;
  /** Sends `["CLOSED", <sub id>, message]`, as a relay does when it refuses a REQ. */
  closed(message: string): void;
}

/**
 * A relay on an OS-assigned loopback port that hands each EVENT to `onEvent`, which decides
 * whether and how to answer. A REQ goes to `onReq`; without one it is never answered, so a
 * read from the stub never finishes.
 */
export async function startStubRelay(
  onEvent: (ev: NostrEvent, ctx: StubContext) => void,
  onReq?: (filters: Record<string, unknown>[], ctx: StubReqContext) => void,
): Promise<StubRelay> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  const stub: StubRelay = {
    url: `ws://127.0.0.1:${port}`,
    received: [],
    connections: 0,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
    },
  };
  wss.on("connection", (socket) => {
    stub.connections++;
    socket.on("message", (data) => {
      const msg = JSON.parse(String(data)) as unknown[];
      if (msg[0] === "REQ" && onReq !== undefined) {
        const subId = msg[1] as string;
        onReq(msg.slice(2) as Record<string, unknown>[], {
          send: (ev) => socket.send(JSON.stringify(["EVENT", subId, ev])),
          eose: () => socket.send(JSON.stringify(["EOSE", subId])),
          closed: (message) => socket.send(JSON.stringify(["CLOSED", subId, message])),
        });
        return;
      }
      if (msg[0] !== "EVENT") return;
      const ev = msg[1] as NostrEvent;
      stub.received.push(ev);
      onEvent(ev, {
        reply: (ok, message) => socket.send(JSON.stringify(["OK", ev.id, ok, message])),
        socket,
        n: stub.received.length,
      });
    });
  });
  return stub;
}
