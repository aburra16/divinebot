import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchRelayInfo, relayInfoUrl, relayPageSize } from "../src/relay.js";

// NIP-11 reads in tests go to a loopback HTTP server or an injected fetcher, never a relay.

describe("relayInfoUrl", () => {
  it("maps wss to https and ws to http, keeping host, port and path", () => {
    expect(relayInfoUrl("wss://relay.example")).toBe("https://relay.example/");
    expect(relayInfoUrl("ws://127.0.0.1:10599/relay")).toBe("http://127.0.0.1:10599/relay");
  });
});

describe("relayPageSize", () => {
  const info = (doc: unknown) => async () => doc;

  it("uses limitation.max_limit from the relay's NIP-11 document", async () => {
    expect(await relayPageSize("ws://127.0.0.1:1", info({ limitation: { max_limit: 300 } }))).toBe(300);
  });

  it("honours max_limit up to 10000, and caps it there", async () => {
    for (const [max, expected] of [[5_001, 5_001], [10_000, 10_000], [10_001, 10_000], [50_000, 10_000]]) {
      expect(await relayPageSize("ws://127.0.0.1:1", info({ limitation: { max_limit: max } }))).toBe(expected);
    }
  });

  it("falls back to 500 when the document has no usable max_limit", async () => {
    for (const doc of [{}, { limitation: {} }, { limitation: { max_limit: "900" } }, { limitation: { max_limit: 0 } }, { limitation: { max_limit: 2.5 } }, null, "text"]) {
      expect(await relayPageSize("ws://127.0.0.1:1", info(doc))).toBe(500);
    }
  });

  it("falls back to 500 when the fetch fails", async () => {
    const failing = async () => {
      throw new Error("no NIP-11 here");
    };
    expect(await relayPageSize("ws://127.0.0.1:1", failing)).toBe(500);
  });
});

describe("fetchRelayInfo", () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = undefined;
  });

  /** A loopback HTTP server; returns the ws:// URL a relay on it would have. */
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("asks for application/nostr+json over http and returns the parsed document", async () => {
    let headers: IncomingHttpHeaders = {};
    const url = await serve((req, res) => {
      headers = req.headers;
      res.setHeader("content-type", "application/nostr+json");
      res.end(JSON.stringify({ name: "test", limitation: { max_limit: 42 } }));
    });
    expect(await fetchRelayInfo(url)).toEqual({ name: "test", limitation: { max_limit: 42 } });
    expect(headers.accept).toBe("application/nostr+json");
    expect(await relayPageSize(url)).toBe(42);
  });

  it("rejects on an HTTP error, so the page size falls back", async () => {
    const url = await serve((_, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    await expect(fetchRelayInfo(url)).rejects.toThrow(/HTTP 404/);
    expect(await relayPageSize(url)).toBe(500);
  });

  it("gives up after its timeout when the server never answers", async () => {
    const url = await serve(() => {});
    const started = Date.now();
    await expect(fetchRelayInfo(url, 200)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
