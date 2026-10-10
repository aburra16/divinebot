import { readFileSync } from "node:fs";
import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import { streamEvents } from "../src/source/divine-relay.js";
import { startStubRelay, type StubRelay } from "./stub-relay.js";

// No live network: every read goes to a loopback stub that behaves like a relay's
// until/limit paging (newest first, ties broken by id).

const native = readFileSync(new URL("./fixtures/native.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as NostrEvent);

const sk = generateSecretKey();
const signed = (created_at: number, n: number): NostrEvent =>
  finalizeEvent({ kind: 34236, created_at, tags: [["d", `v${n}`]], content: "" }, sk);

/** Twelve events; the middle four (indexes 2 to 5 newest first) share one created_at. */
function twelve(): NostrEvent[] {
  const stamps = [1000, 990, 980, 980, 980, 980, 970, 960, 950, 940, 930, 920];
  return stamps.map((t, i) => signed(t, i));
}

function newestFirst(events: NostrEvent[]): NostrEvent[] {
  return [...events].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
}

/** What a relay answers to one filter: events up to `until`, newest first, at most `limit`. */
function answer(events: NostrEvent[], filter: Record<string, unknown>): NostrEvent[] {
  const until = typeof filter.until === "number" ? filter.until : Infinity;
  const limit = typeof filter.limit === "number" ? filter.limit : events.length;
  return newestFirst(events)
    .filter((e) => e.created_at <= until)
    .slice(0, limit);
}

describe("streamEvents", () => {
  let stub: StubRelay | undefined;

  afterEach(async () => {
    await stub?.close();
    stub = undefined;
  });

  /** Closes the stub now (a dropped relay) and tells afterEach there is nothing left to close. */
  async function dropStub(): Promise<void> {
    const s = stub;
    stub = undefined;
    await s?.close();
  }

  const noSleep = async () => {};
  const opts = (extra: Partial<Parameters<typeof streamEvents>[2]> = {}) => ({
    pageSize: 5,
    pageDelayMs: 1000,
    readTimeoutMs: 2000,
    sleep: noSleep,
    onRetry: () => {},
    ...extra,
  });

  async function serve(events: NostrEvent[], seen: Record<string, unknown>[] = []): Promise<string> {
    stub = await startStubRelay(
      () => {},
      (filters, ctx) => {
        seen.push(filters[0]!);
        for (const ev of answer(events, filters[0]!)) ctx.send(ev);
        ctx.eose();
      },
    );
    return stub.url;
  }

  it("delivers every event exactly once across a page boundary inside one created_at", async () => {
    const events = twelve();
    const url = await serve(events);
    const delivered: NostrEvent[][] = [];
    const result = await streamEvents(url, { kinds: [34236] }, opts(), (page) => {
      delivered.push(page);
    });
    const ids = delivered.flat().map((e) => e.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids)).toEqual(new Set(events.map((e) => e.id)));
    expect(result.events).toBe(12);
    expect(result.rejected).toBe(0);
    expect(result.stalledAt).toBeUndefined();
    // Four pages bring something new; a fifth only repeats the oldest event and ends the read.
    expect(delivered.map((p) => p.length)).toEqual([5, 2, 4, 1]);
    expect(result.pages).toBe(5);
  });

  it("pages back with until set to the oldest created_at seen, and limit to the page size", async () => {
    const seen: Record<string, unknown>[] = [];
    const url = await serve(twelve(), seen);
    await streamEvents(url, { kinds: [34236] }, opts(), () => {});
    expect(seen[0]).toEqual({ kinds: [34236], limit: 5 });
    expect(seen.slice(1).map((f) => f.until)).toEqual([980, 970, 930, 920]);
    expect(seen.every((f) => f.limit === 5 && Array.isArray(f.kinds))).toBe(true);
  });

  it("keeps a caller's own until on the first request", async () => {
    const seen: Record<string, unknown>[] = [];
    const url = await serve(twelve(), seen);
    const result = await streamEvents(url, { kinds: [34236], until: 975 }, opts(), () => {});
    expect(seen[0]!.until).toBe(975);
    expect(result.events).toBe(6);
  });

  it("uses one connection for every page", async () => {
    const url = await serve(twelve());
    await streamEvents(url, {}, opts(), () => {});
    expect(stub!.connections).toBe(1);
  });

  it("sleeps pageDelayMs between pages, and only between them", async () => {
    const url = await serve(twelve());
    const sleeps: number[] = [];
    const result = await streamEvents(
      url,
      {},
      opts({ sleep: async (ms) => void sleeps.push(ms) }),
      () => {},
    );
    expect(sleeps).toEqual(new Array(result.pages - 1).fill(1000));
  });

  it("waits for onPage to finish before it asks for the next page", async () => {
    const log: string[] = [];
    stub = await startStubRelay(
      () => {},
      (filters, ctx) => {
        log.push("req");
        for (const ev of answer(twelve(), filters[0]!)) ctx.send(ev);
        ctx.eose();
      },
    );
    await streamEvents(stub.url, {}, opts(), async () => {
      log.push("page-start");
      await new Promise((r) => setTimeout(r, 20));
      log.push("page-end");
    });
    expect(log.slice(0, 5)).toEqual(["req", "page-start", "page-end", "req", "page-start"]);
  });

  it("drops an event whose signature does not verify and counts it", async () => {
    const good = [signed(500, 1), signed(400, 2), signed(300, 3)];
    const forged = structuredClone(native[0]!);
    forged.created_at = 450;
    forged.tags[0] = ["d", "tampered"];
    const url = await serve([...good, forged]);
    const delivered: NostrEvent[] = [];
    const result = await streamEvents(url, {}, opts({ pageSize: 10 }), (page) => {
      delivered.push(...page);
    });
    expect(result.rejected).toBe(1);
    expect(result.events).toBe(3);
    expect(delivered.map((e) => e.id).sort()).toEqual(good.map((e) => e.id).sort());
  });

  it("counts a forged event once even when it is sent on two pages", async () => {
    const good = [signed(500, 1), signed(400, 2), signed(300, 3)];
    const forged = structuredClone(native[0]!);
    forged.created_at = 400;
    forged.tags[0] = ["d", "tampered"];
    const url = await serve([...good, forged]);
    const result = await streamEvents(url, {}, opts({ pageSize: 3 }), () => {});
    expect(result.rejected).toBe(1);
    expect(result.events).toBe(3);
  });

  it("rejects an event that is not even shaped like one without crashing", async () => {
    stub = await startStubRelay(
      () => {},
      (_filters, ctx) => {
        ctx.send({ id: "x" } as unknown as NostrEvent);
        ctx.send(signed(10, 1));
        ctx.eose();
      },
    );
    const result = await streamEvents(stub.url, {}, opts({ pageSize: 10 }), () => {});
    expect(result.rejected).toBe(1);
    expect(result.events).toBe(1);
  });

  it("reports stalledAt when more than a page of events share one created_at", async () => {
    const events = Array.from({ length: 6 }, (_, i) => signed(700, i));
    const url = await serve(events);
    const result = await streamEvents(url, {}, opts({ pageSize: 5 }), () => {});
    expect(result.stalledAt).toBe(700);
    expect(result.events).toBe(5);
  });

  it("does not call onPage for an empty read", async () => {
    const url = await serve([]);
    let calls = 0;
    const result = await streamEvents(url, {}, opts(), () => {
      calls++;
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ pages: 1, events: 0, rejected: 0 });
  });

  it("rejects naming the relay when it answers CLOSED", async () => {
    stub = await startStubRelay(
      () => {},
      (_filters, ctx) => ctx.closed("rate-limited: slow down"),
    );
    const url = stub.url;
    await expect(streamEvents(url, {}, opts(), () => {})).rejects.toThrow(url);
    await expect(streamEvents(url, {}, opts(), () => {})).rejects.toThrow(/rate-limited: slow down/);
  });

  it("rejects after onPage ran once when the socket drops after the first page", async () => {
    const events = twelve();
    let reqs = 0;
    stub = await startStubRelay(
      () => {},
      (filters, ctx) => {
        reqs++;
        if (reqs > 1) {
          void dropStub();
          return;
        }
        for (const ev of answer(events, filters[0]!)) ctx.send(ev);
        ctx.eose();
      },
    );
    const url = stub.url;
    let calls = 0;
    await expect(
      streamEvents(url, {}, opts({ maxRetries: 0 }), () => {
        calls++;
      }),
    ).rejects.toThrow(url);
    expect(calls).toBe(1);
  });

  it("rejects when the socket is gone before the next page is asked for", async () => {
    const events = twelve();
    stub = await startStubRelay(
      () => {},
      (filters, ctx) => {
        for (const ev of answer(events, filters[0]!)) ctx.send(ev);
        ctx.eose();
      },
    );
    const url = stub.url;
    await expect(
      streamEvents(url, {}, opts({ maxRetries: 0 }), async () => {
        await dropStub();
        await new Promise((r) => setTimeout(r, 50));
      }),
    ).rejects.toThrow(url);
  });

  it("rejects naming the relay when nothing listens at the address", async () => {
    const dead = await startStubRelay(() => {});
    const url = dead.url;
    await dead.close();
    await expect(streamEvents(url, {}, opts({ maxRetries: 0 }), () => {})).rejects.toThrow(url);
  });

  it("rejects naming the relay when no EOSE arrives within readTimeoutMs", async () => {
    stub = await startStubRelay(() => {}, () => {});
    const url = stub.url;
    await expect(streamEvents(url, {}, opts({ readTimeoutMs: 100, maxRetries: 0 }), () => {})).rejects.toThrow(url);
  });

  it("rejects when onPage throws, and closes the socket", async () => {
    const url = await serve(twelve());
    await expect(
      streamEvents(url, {}, opts(), () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    await new Promise((r) => setTimeout(r, 50));
    // A second read on the same stub shows the failed one left nothing behind.
    await expect(streamEvents(url, {}, opts(), () => {})).resolves.toMatchObject({ events: 12 });
  });

  describe("retries a dropped page", () => {
    it("reconnects after a mid-page drop and delivers every event exactly once", async () => {
      const events = twelve();
      let reqs = 0;
      stub = await startStubRelay(
        () => {},
        (filters, ctx) => {
          reqs++;
          const page = answer(events, filters[0]!);
          if (reqs === 2) {
            // The second REQ is the second page: send part of it, then reset the socket.
            for (const ev of page.slice(0, 1)) ctx.send(ev);
            setTimeout(() => stub!.terminateClients(), 20);
            return;
          }
          for (const ev of page) ctx.send(ev);
          ctx.eose();
        },
      );
      const delivered: NostrEvent[] = [];
      const retries: [number, string][] = [];
      const sleeps: number[] = [];
      const result = await streamEvents(
        stub.url,
        {},
        opts({
          onRetry: (attempt, why) => void retries.push([attempt, why]),
          sleep: async (ms) => void sleeps.push(ms),
        }),
        (page) => {
          delivered.push(...page);
        },
      );
      const ids = delivered.map((e) => e.id);
      expect(ids).toHaveLength(12);
      expect(new Set(ids)).toEqual(new Set(events.map((e) => e.id)));
      expect(result.events).toBe(12);
      expect(retries).toHaveLength(1);
      expect(retries[0]![0]).toBe(1);
      expect(retries[0]![1]).toMatch(/dropped the connection/);
      expect(stub.connections).toBe(2);
      // One backoff for the retry, then the usual page delays.
      expect(sleeps).toContain(2000);
    });

    it("rejects after five attempts when the relay always drops, backing off between them", async () => {
      stub = await startStubRelay(
        () => {},
        () => {
          setTimeout(() => stub?.terminateClients(), 5);
        },
      );
      const url = stub.url;
      const retries: number[] = [];
      const sleeps: number[] = [];
      await expect(
        streamEvents(
          url,
          {},
          opts({
            onRetry: (attempt) => void retries.push(attempt),
            sleep: async (ms) => void sleeps.push(ms),
          }),
          () => {},
        ),
      ).rejects.toThrow(url);
      expect(stub.connections).toBe(5);
      expect(retries).toEqual([1, 2, 3, 4]);
      expect(sleeps).toEqual([2000, 5000, 15000, 30000]);
    });

    it("retries a connect failure with the same budget and rejects when it never opens", async () => {
      const dead = await startStubRelay(() => {});
      const url = dead.url;
      await dead.close();
      const retries: number[] = [];
      await expect(
        streamEvents(url, {}, opts({ onRetry: (attempt) => void retries.push(attempt) }), () => {}),
      ).rejects.toThrow(url);
      expect(retries).toEqual([1, 2, 3, 4]);
    });

    it("does not retry when the relay answers CLOSED", async () => {
      let reqs = 0;
      stub = await startStubRelay(
        () => {},
        (_filters, ctx) => {
          reqs++;
          ctx.closed("rate-limited: slow down");
        },
      );
      const retries: number[] = [];
      await expect(
        streamEvents(stub.url, {}, opts({ onRetry: (attempt) => void retries.push(attempt) }), () => {}),
      ).rejects.toThrow(/rate-limited: slow down/);
      expect(reqs).toBe(1);
      expect(retries).toEqual([]);
    });

    it("retries a silence timeout and resolves when the next attempt is answered", async () => {
      const events = twelve();
      let reqs = 0;
      stub = await startStubRelay(
        () => {},
        (filters, ctx) => {
          reqs++;
          if (reqs === 1) return; // never answered
          for (const ev of answer(events, filters[0]!)) ctx.send(ev);
          ctx.eose();
        },
      );
      const retries: string[] = [];
      const result = await streamEvents(
        stub.url,
        {},
        opts({ readTimeoutMs: 100, onRetry: (_a, why) => void retries.push(why) }),
        () => {},
      );
      expect(result.events).toBe(12);
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatch(/did not finish the read/);
    });

    it("never moves past unread events: a page that keeps dropping delivers nothing from it", async () => {
      const events = twelve();
      stub = await startStubRelay(
        () => {},
        (filters, ctx) => {
          if (filters[0]!.until !== undefined) {
            ctx.send(answer(events, filters[0]!)[0]!);
            setTimeout(() => stub?.terminateClients(), 5);
            return;
          }
          for (const ev of answer(events, filters[0]!)) ctx.send(ev);
          ctx.eose();
        },
      );
      const delivered: NostrEvent[] = [];
      await expect(
        streamEvents(stub.url, {}, opts({ maxRetries: 2 }), (page) => {
          delivered.push(...page);
        }),
      ).rejects.toThrow(/dropped the connection/);
      expect(delivered).toHaveLength(5);
    });

    it("uses the default writer on stderr when onRetry is not given", async () => {
      const writes: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        let reqs = 0;
        stub = await startStubRelay(
          () => {},
          (filters, ctx) => {
            reqs++;
            if (reqs === 1) return;
            for (const ev of answer(twelve(), filters[0]!)) ctx.send(ev);
            ctx.eose();
          },
        );
        const { onRetry: _drop, ...bare } = opts({ readTimeoutMs: 100 });
        await streamEvents(stub.url, {}, bare, () => {});
      } finally {
        process.stderr.write = orig;
      }
      expect(writes.join("")).toMatch(/retry 1 of 4/);
    });
  });

  it("rejects a pageSize that is not a positive integer", async () => {
    await expect(streamEvents("ws://127.0.0.1:1", {}, opts({ pageSize: 0 }), () => {})).rejects.toThrow(/pageSize/);
  });
});
