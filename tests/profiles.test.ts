import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { loadConfig, type Config } from "../src/config.js";
import { cachedNip05, creatorName, lookupNip05, refreshProfiles, verifiedNip05 } from "../src/profiles.js";
import type { PageOptions, StreamResult, streamEvents } from "../src/source/divine-relay.js";
import { openState, type State } from "../src/state.js";

const cfg: Config = loadConfig(new URL("../config.json", import.meta.url).pathname);
const NOW = 1_800_000_000;
const DAY = 86_400;
const IMR = "03c49dd3d68fdd15fc0bc7dff669d652af313408bfd6dde10daf27b02f54eb50";
const OTHER = "b".repeat(64);
const now = () => NOW;

const hex = (i: number) => i.toString(16).padStart(64, "0");

type Reply = Response | Error | ((signal: AbortSignal | undefined) => Promise<Response>);
/** A fetch that answers per URL with `answer`, and records each call. */
function fakeFetch(answer: (url: string) => Reply | undefined) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = answer(url) ?? new Response("not found", { status: 404 });
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r(init?.signal ?? undefined);
    return r;
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The two divine.video lookups for creator `imrdaviis`, each answering `sub` and `root`. */
function divineFetch(sub: string | undefined, root: string | undefined) {
  return fakeFetch((url) => {
    if (url === "https://imrdaviis.divine.video/.well-known/nostr.json?name=_") {
      return sub === undefined ? json({ names: {} }) : json({ names: { _: sub } });
    }
    if (url === "https://divine.video/.well-known/nostr.json?name=imrdaviis") {
      return root === undefined ? json({ names: {} }) : json({ names: { imrdaviis: root } });
    }
    return undefined;
  });
}

describe("creatorName", () => {
  it("prefers display_name, else name, trimmed and non-empty", () => {
    expect(creatorName({ display_name: "  ", name: "julia" })).toBe("julia");
    expect(creatorName({ display_name: " Julia ", name: "j" })).toBe("Julia");
    expect(creatorName({ name: "  julia  " })).toBe("julia");
    expect(creatorName({ display_name: 5, name: "julia" })).toBe("julia");
    expect(creatorName({ display_name: "", name: " " })).toBeUndefined();
    expect(creatorName({})).toBeUndefined();
    expect(creatorName(undefined)).toBeUndefined();
  });

  it("keeps fancy Unicode verbatim", () => {
    expect(creatorName({ display_name: "𝖎𝖒𝖗𝖉𝖆𝖛𝖎𝖎𝖘 💀" })).toBe("𝖎𝖒𝖗𝖉𝖆𝖛𝖎𝖎𝖘 💀");
  });
});

describe("lookupNip05", () => {
  it("requests the well-known URL without following redirects and returns the pubkey", async () => {
    const { fetch, calls } = fakeFetch(() => json({ names: { _: IMR } }));
    expect(await lookupNip05("_@imrdaviis.divine.video", { timeoutMs: 5000, fetch })).toBe(IMR);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://imrdaviis.divine.video/.well-known/nostr.json?name=_");
    expect(calls[0]!.init?.redirect).toBe("manual");
    expect(calls[0]!.init?.signal).toBeDefined();
  });

  it("lowercases the local part, so a mixed-case identifier finds the lowercase name", async () => {
    const { fetch, calls } = fakeFetch(() => json({ names: { alice: IMR } }));
    expect(await lookupNip05("Alice@Example.COM", { timeoutMs: 5000, fetch })).toBe(IMR);
    expect(calls[0]!.url).toBe("https://example.com/.well-known/nostr.json?name=alice");
  });

  it("returns null for a name that is not an exact key or not 64 lowercase hex", async () => {
    for (const body of [
      { names: { Alice: IMR } },
      { names: { alice: IMR.toUpperCase() } },
      { names: { alice: IMR.slice(2) } },
      { names: { alice: 5 } },
      { names: { alice: [IMR] } },
      { names: null },
      { names: [IMR] },
      { names: { toString: IMR } },
      {},
      [],
      "x",
      null,
    ]) {
      const { fetch } = fakeFetch(() => json(body));
      expect(await lookupNip05("alice@example.com", { timeoutMs: 5000, fetch })).toBeNull();
    }
  });

  it("returns null without a request for a malformed identifier", async () => {
    const { fetch, calls } = fakeFetch(() => json({ names: { _: IMR } }));
    for (const id of [
      "",
      "alice",
      "example.com",
      "@example.com",
      "alice@",
      "a@b@example.com",
      "alice@example.com/path",
      "alice@example.com:8080",
      "alice@localhost",
      "alice@127.0.0.1",
      "alice@[::1]",
      "alice@exa mple.com",
      "alice@example.com.",
      "alice@.example.com",
      "ali ce@example.com",
      "ali/ce@example.com",
      "alice?x=1@example.com",
      "alice@user:pw@example.com",
      "alice@example.com#frag",
    ]) {
      expect(await lookupNip05(id, { timeoutMs: 5000, fetch }), id).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it("returns null for any non-200 status, redirects included", async () => {
    for (const status of [301, 302, 307, 308, 204, 404, 500]) {
      const { fetch } = fakeFetch(
        () => new Response(JSON.stringify({ names: { alice: IMR } }), { status, headers: { location: "https://evil.example/" } }),
      );
      expect(await lookupNip05("alice@example.com", { timeoutMs: 5000, fetch }), String(status)).toBeNull();
    }
  });

  it("returns null for a body over 64 KB and stops reading it", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
        if (pulled > 1000) controller.close();
      },
    });
    const { fetch } = fakeFetch(() => new Response(body, { status: 200 }));
    expect(await lookupNip05("alice@example.com", { timeoutMs: 5000, fetch })).toBeNull();
    expect(pulled).toBeLessThan(20);
  });

  it("accepts a body just under the limit", async () => {
    const pad = "x".repeat(60 * 1024);
    const { fetch } = fakeFetch(() => json({ pad, names: { alice: IMR } }));
    expect(await lookupNip05("alice@example.com", { timeoutMs: 5000, fetch })).toBe(IMR);
  });

  it("returns null for invalid JSON and for a network error", async () => {
    const bad = fakeFetch(() => new Response("<html>", { status: 200 }));
    expect(await lookupNip05("alice@example.com", { timeoutMs: 5000, fetch: bad.fetch })).toBeNull();
    const down = fakeFetch(() => new Error("ECONNRESET"));
    expect(await lookupNip05("alice@example.com", { timeoutMs: 5000, fetch: down.fetch })).toBeNull();
  });

  describe("a slow server", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("gives up after the timeout even when fetch ignores the abort signal", async () => {
      const { fetch } = fakeFetch(
        () => () => new Promise<Response>((resolve) => setTimeout(() => resolve(json({ names: { alice: IMR } })), 6000)),
      );
      const result = lookupNip05("alice@example.com", { timeoutMs: 5000, fetch });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBeNull();
    });

    it("gives up on a body that stalls after the headers", async () => {
      const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
      const { fetch } = fakeFetch(() => new Response(body, { status: 200 }));
      const result = lookupNip05("alice@example.com", { timeoutMs: 5000, fetch });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBeNull();
    });

    it("aborts the request on timeout", async () => {
      let signal: AbortSignal | undefined;
      const { fetch } = fakeFetch(() => (s) => {
        signal = s;
        return new Promise<Response>(() => {});
      });
      const result = lookupNip05("alice@example.com", { timeoutMs: 5000, fetch });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBeNull();
      expect(signal?.aborted).toBe(true);
    });
  });
});

describe("verifiedNip05 and cachedNip05", () => {
  let state: State;
  beforeEach(() => {
    state = openState(":memory:");
  });
  afterEach(() => state.close());

  const verify = (
    content: Record<string, unknown> | undefined,
    f: typeof fetch,
    pubkey = IMR,
    at: () => number = now,
  ) => verifiedNip05(pubkey, content, state, cfg, { now: at, fetch: f });

  it("writes <u>@divine.video when both lookups return the pubkey", async () => {
    const { fetch } = divineFetch(IMR, IMR);
    expect(await verify({ nip05: "_@imrdaviis.divine.video" }, fetch)).toBe("imrdaviis@divine.video");
    expect(cachedNip05(IMR, { nip05: "_@imrdaviis.divine.video" }, state)).toBe("imrdaviis@divine.video");
  });

  it("keeps _@<u>.divine.video when only the subdomain lookup matches", async () => {
    for (const root of [undefined, OTHER]) {
      const fresh = openState(":memory:");
      const { fetch } = divineFetch(IMR, root);
      const c = { nip05: "_@imrdaviis.divine.video" };
      expect(await verifiedNip05(IMR, c, fresh, cfg, { now, fetch })).toBe("_@imrdaviis.divine.video");
      expect(cachedNip05(IMR, c, fresh)).toBe("_@imrdaviis.divine.video");
      fresh.close();
    }
  });

  it("returns undefined when the subdomain lookup fails, even if the root matches", async () => {
    const { fetch } = divineFetch(undefined, IMR);
    const c = { nip05: "_@imrdaviis.divine.video" };
    expect(await verify(c, fetch)).toBeUndefined();
    expect(cachedNip05(IMR, c, state)).toBeUndefined();
  });

  it("returns other verified identifiers as they are, and undefined for a mismatched pubkey", async () => {
    const { fetch } = fakeFetch(() => json({ names: { alice: IMR } }));
    expect(await verify({ nip05: "alice@example.com" }, fetch)).toBe("alice@example.com");
    expect(await verify({ nip05: "alice@example.com" }, fetch, OTHER)).toBeUndefined();
  });

  it("does not rewrite a divine.video identifier that is not _@<u>.divine.video", async () => {
    const { fetch, calls } = fakeFetch(() => json({ names: { _: IMR, bob: IMR } }));
    expect(await verify({ nip05: "_@a.b.divine.video" }, fetch)).toBe("_@a.b.divine.video");
    expect(await verify({ nip05: "bob@divine.video" }, fetch)).toBe("bob@divine.video");
    expect(await verify({ nip05: "bob@x.divine.video" }, fetch)).toBe("bob@x.divine.video");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("gives undefined for a 301, a 1 MB body and a mismatched pubkey", async () => {
    const c = { nip05: "alice@example.com" };
    const moved = fakeFetch(() => new Response("", { status: 301, headers: { location: "https://elsewhere/" } }));
    expect(await verify(c, moved.fetch)).toBeUndefined();
    const huge = fakeFetch(() => new Response(`{"pad":"${"x".repeat(1_000_000)}","names":{"alice":"${IMR}"}}`));
    expect(await verify(c, huge.fetch)).toBeUndefined();
    const wrong = fakeFetch(() => json({ names: { alice: OTHER } }));
    expect(await verify(c, wrong.fetch)).toBeUndefined();
  });

  it("gives undefined after a 6 s delay (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = fakeFetch(
        () => () => new Promise<Response>((resolve) => setTimeout(() => resolve(json({ names: { alice: IMR } })), 6000)),
      );
      const result = verify({ nip05: "alice@example.com" }, fetch);
      await vi.advanceTimersByTimeAsync(cfg.profiles.nip05TimeoutMs);
      expect(await result).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives undefined without a request when there is no usable nip05", async () => {
    const { fetch, calls } = fakeFetch(() => json({ names: { alice: IMR } }));
    for (const content of [undefined, {}, { nip05: "" }, { nip05: "  " }, { nip05: 5 }, { nip05: "nope" }, { nip05: null }]) {
      expect(await verify(content as Record<string, unknown> | undefined, fetch)).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
  });

  it("returns the profile's own identifier, trimmed, and caches under the normalized key", async () => {
    const { fetch, calls } = fakeFetch(() => json({ names: { alice: IMR } }));
    const c = { nip05: "  Alice@Example.com " };
    expect(await verify(c, fetch)).toBe("Alice@Example.com");
    expect(calls[0]!.url).toBe("https://example.com/.well-known/nostr.json?name=alice");
    expect(state.nip05("alice@example.com")).toEqual({ pubkey: IMR, checkedAt: NOW });
    expect(cachedNip05(IMR, c, state)).toBe("Alice@Example.com");
  });

  it("returns a Unicode domain verbatim and looks it up in punycode", async () => {
    const { fetch, calls } = fakeFetch(() => json({ names: { bob: IMR } }));
    expect(await verify({ nip05: "bob@Bücher.example" }, fetch)).toBe("bob@Bücher.example");
    expect(calls[0]!.url).toBe("https://xn--bcher-kva.example/.well-known/nostr.json?name=bob");
  });

  it("uses a result younger than nip05TtlDays without a request, including a cached failure", async () => {
    const ttl = cfg.profiles.nip05TtlDays * DAY;
    state.putNip05("alice@example.com", IMR, NOW - ttl + 10);
    state.putNip05("bob@example.com", null, NOW - ttl + 10);
    const { fetch, calls } = fakeFetch(() => json({ names: { alice: OTHER, bob: IMR } }));
    expect(await verify({ nip05: "alice@example.com" }, fetch)).toBe("alice@example.com");
    expect(await verify({ nip05: "bob@example.com" }, fetch)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("looks up again and stores the answer once the cached result is older than the TTL", async () => {
    const ttl = cfg.profiles.nip05TtlDays * DAY;
    state.putNip05("alice@example.com", OTHER, NOW - ttl - 1);
    const { fetch, calls } = fakeFetch(() => json({ names: { alice: IMR } }));
    expect(await verify({ nip05: "alice@example.com" }, fetch)).toBe("alice@example.com");
    expect(calls).toHaveLength(1);
    expect(state.nip05("alice@example.com")).toEqual({ pubkey: IMR, checkedAt: NOW });
  });

  it("keeps an earlier positive result and its checkedAt when the lookup is unavailable", async () => {
    const ttl = cfg.profiles.nip05TtlDays * DAY;
    const stale = NOW - ttl - 5;
    const c = { nip05: "alice@example.com" };
    const failures: [string, Reply][] = [
      ["a network error", new Error("ECONNRESET")],
      ["a 503", new Response("down", { status: 503 })],
      ["a 429", new Response("slow down", { status: 429 })],
      ["a 200 that is not nostr.json", new Response("<html>maintenance</html>", { status: 200 })],
      ["a 200 without names", json({ error: "busy" })],
    ];
    for (const [label, reply] of failures) {
      state.putNip05("alice@example.com", IMR, stale);
      const { fetch, calls } = fakeFetch(() => reply);
      expect(await verify(c, fetch), label).toBe("alice@example.com");
      expect(calls, label).toHaveLength(1);
      expect(state.nip05("alice@example.com"), label).toEqual({ pubkey: IMR, checkedAt: stale });
    }
  });

  it("writes nothing for a first lookup that is unavailable, so the next call tries again", async () => {
    const down = fakeFetch(() => new Error("boom"));
    expect(await verify({ nip05: "alice@example.com" }, down.fetch)).toBeUndefined();
    expect(state.nip05("alice@example.com")).toBeUndefined();
    const again = fakeFetch(() => json({ names: { alice: IMR } }));
    expect(await verify({ nip05: "alice@example.com" }, again.fetch)).toBe("alice@example.com");
    expect(again.calls).toHaveLength(1);
  });

  it("stores a definitive answer: a 404, a redirect, an absent name or a mismatch replaces the cached row", async () => {
    const ttl = cfg.profiles.nip05TtlDays * DAY;
    const answers: [string, Reply, string | null][] = [
      ["404", new Response("", { status: 404 }), null],
      ["301", new Response("", { status: 301, headers: { location: "https://x/" } }), null],
      ["absent", json({ names: {} }), null],
      ["mismatch", json({ names: { alice: OTHER } }), OTHER],
      ["over the cap", new Response("x".repeat(70_000)), null],
    ];
    for (const [label, reply, stored] of answers) {
      state.putNip05("alice@example.com", IMR, NOW - ttl - 5);
      const { fetch } = fakeFetch(() => reply);
      expect(await verify({ nip05: "alice@example.com" }, fetch), label).toBeUndefined();
      expect(state.nip05("alice@example.com"), label).toEqual({ pubkey: stored, checkedAt: NOW });
    }
  });

  it("matches the pubkey case-insensitively", async () => {
    const { fetch } = fakeFetch(() => json({ names: { alice: IMR } }));
    expect(await verify({ nip05: "alice@example.com" }, fetch, IMR.toUpperCase())).toBe("alice@example.com");
  });

  describe("cachedNip05", () => {
    it("never touches the network and ignores the TTL", () => {
      state.putNip05("alice@example.com", IMR, NOW - 100 * DAY);
      expect(cachedNip05(IMR, { nip05: "alice@example.com" }, state)).toBe("alice@example.com");
      expect(cachedNip05(OTHER, { nip05: "alice@example.com" }, state)).toBeUndefined();
    });

    it("is undefined without a cached result or for a cached failure", () => {
      expect(cachedNip05(IMR, { nip05: "alice@example.com" }, state)).toBeUndefined();
      state.putNip05("alice@example.com", null, NOW);
      expect(cachedNip05(IMR, { nip05: "alice@example.com" }, state)).toBeUndefined();
      expect(cachedNip05(IMR, undefined, state)).toBeUndefined();
      expect(cachedNip05(IMR, { nip05: 3 }, state)).toBeUndefined();
    });

    it("applies the divine.video rule to what is cached", () => {
      const c = { nip05: "_@imrdaviis.divine.video" };
      state.putNip05("_@imrdaviis.divine.video", IMR, NOW);
      expect(cachedNip05(IMR, c, state)).toBe("_@imrdaviis.divine.video");
      state.putNip05("imrdaviis@divine.video", OTHER, NOW);
      expect(cachedNip05(IMR, c, state)).toBe("_@imrdaviis.divine.video");
      state.putNip05("imrdaviis@divine.video", IMR, NOW - 90 * DAY);
      expect(cachedNip05(IMR, c, state)).toBe("imrdaviis@divine.video");
    });
  });
});

describe("refreshProfiles", () => {
  let state: State;
  beforeEach(() => {
    state = openState(":memory:");
  });
  afterEach(() => state.close());

  function video(author: string, i: number): NostrEvent {
    return {
      id: hex(10_000 + i),
      pubkey: author,
      created_at: 1_700_000_000 + i,
      kind: 34236,
      tags: [["d", `v${i}`], ["title", `Video ${i}`]],
      content: "",
      sig: "0".repeat(128),
    };
  }

  function profileEvent(author: string, createdAt: number, content: unknown, id?: string): NostrEvent {
    return {
      id: id ?? hex(50_000 + createdAt),
      pubkey: author,
      created_at: createdAt,
      kind: 0,
      tags: [],
      content: typeof content === "string" ? content : JSON.stringify(content),
      sig: "0".repeat(128),
    };
  }

  const addSource = (ev: NostrEvent, skip: string | null = null, status: "active" | "deleted" = "active") => {
    state.upsertSource(ev, "native", skip, NOW);
    if (status !== "active") state.setSourceStatus(`${ev.pubkey}:${ev.tags[0]![1]}`, status, NOW);
  };

  interface Call {
    url: string;
    filter: Filter;
    opts: PageOptions;
  }
  function fakeStream(events: NostrEvent[], opts: { pageSize?: number; failFor?: (call: Call) => boolean; stalledAt?: number } = {}) {
    const calls: Call[] = [];
    const stream: typeof streamEvents = async (url, filter, o, onPage) => {
      const call = { url, filter, opts: o };
      calls.push(call);
      if (opts.failFor?.(call)) throw new Error(`the relay at ${url} closed the connection`);
      const matching = events.filter((ev) => filter.kinds?.includes(ev.kind) && filter.authors?.includes(ev.pubkey));
      const result: StreamResult = { pages: 0, events: 0, rejected: 0 };
      const size = opts.pageSize ?? 3;
      for (let i = 0; i < matching.length; i += size) {
        const page = matching.slice(i, i + size);
        await onPage(page);
        result.pages++;
        result.events += page.length;
      }
      if (opts.stalledAt !== undefined) result.stalledAt = opts.stalledAt;
      return result;
    };
    return { stream, calls };
  }

  const noFetch = fakeFetch(() => undefined);

  it("fetches kind 0 from the source relay for creators of eligible active sources only", async () => {
    addSource(video(hex(1), 1));
    addSource(video(hex(1), 2));
    addSource(video(hex(2), 3), "not a Divine video");
    addSource(video(hex(3), 4), null, "deleted");
    const { stream, calls } = fakeStream([profileEvent(hex(1), 100, { name: "one" })]);
    const out = await refreshProfiles(cfg, state, { now, stream, fetch: noFetch.fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(cfg.source.relay);
    expect(calls[0]!.filter).toMatchObject({ kinds: [0], authors: [hex(1)] });
    expect(calls[0]!.opts).toMatchObject({
      pageSize: cfg.source.pageSize,
      pageDelayMs: cfg.source.pageDelayMs,
      readTimeoutMs: cfg.source.readTimeoutMs,
    });
    expect(out).toEqual({ fetched: 1, verified: 0 });
    expect(state.profile(hex(1))).toEqual({ content: { name: "one" }, createdAt: 100, fetchedAt: NOW });
    expect(state.profile(hex(2))).toBeUndefined();
    expect(state.profile(hex(3))).toBeUndefined();
  });

  it("sends author batches of at most 500", async () => {
    for (let i = 1; i <= 1200; i++) addSource(video(hex(i), i));
    const { stream, calls } = fakeStream([]);
    await refreshProfiles(cfg, state, { now, stream, fetch: noFetch.fetch });
    expect(calls.map((c) => c.filter.authors!.length)).toEqual([500, 500, 200]);
    const all = calls.flatMap((c) => c.filter.authors!);
    expect(new Set(all).size).toBe(1200);
  });

  it("keeps the newest kind 0 per author, the lower id on a tie", async () => {
    addSource(video(hex(1), 1));
    addSource(video(hex(2), 2));
    addSource(video(hex(3), 3));
    const { stream } = fakeStream(
      [
        profileEvent(hex(1), 100, { name: "old" }, hex(901)),
        profileEvent(hex(1), 300, { name: "new" }, hex(902)),
        profileEvent(hex(1), 200, { name: "mid" }, hex(903)),
        profileEvent(hex(2), 100, { name: "high id" }, hex(950)),
        profileEvent(hex(2), 100, { name: "low id" }, hex(940)),
        profileEvent(hex(2), 100, { name: "higher id" }, hex(960)),
        profileEvent(hex(3), 50, { name: "three" }, hex(970)),
      ],
      { pageSize: 2 },
    );
    const out = await refreshProfiles(cfg, state, { now, stream, fetch: noFetch.fetch });
    expect(out.fetched).toBe(3);
    expect(state.profile(hex(1))?.content).toEqual({ name: "new" });
    expect(state.profile(hex(1))?.createdAt).toBe(300);
    expect(state.profile(hex(2))?.content).toEqual({ name: "low id" });
  });

  it("treats invalid JSON and non-object content as no profile without throwing", async () => {
    for (let i = 1; i <= 5; i++) addSource(video(hex(i), i));
    const { stream } = fakeStream([
      profileEvent(hex(1), 100, "not json"),
      profileEvent(hex(2), 100, "[1,2]"),
      profileEvent(hex(3), 100, "42"),
      profileEvent(hex(4), 100, "null"),
      profileEvent(hex(5), 100, { name: "ok" }),
    ]);
    await refreshProfiles(cfg, state, { now, stream, fetch: noFetch.fetch });
    for (const i of [1, 2, 3, 4]) expect(creatorName(state.profile(hex(i))?.content)).toBeUndefined();
    expect(creatorName(state.profile(hex(5))?.content)).toBe("ok");
  });

  it("skips creators whose profile is fresh and refetches stale ones", async () => {
    addSource(video(hex(1), 1));
    addSource(video(hex(2), 2));
    const refresh = cfg.profiles.refreshDays * DAY;
    state.putProfile(hex(1), { name: "fresh" }, 10, NOW - refresh + 100);
    state.putProfile(hex(2), { name: "stale" }, 10, NOW - refresh - 100);
    const { stream, calls } = fakeStream([profileEvent(hex(2), 500, { name: "renewed" })]);
    await refreshProfiles(cfg, state, { now, stream, fetch: noFetch.fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filter.authors).toEqual([hex(2)]);
    expect(state.profile(hex(1))?.content).toEqual({ name: "fresh" });
    expect(state.profile(hex(2))).toEqual({ content: { name: "renewed" }, createdAt: 500, fetchedAt: NOW });
  });

  it("makes no request when every profile is fresh", async () => {
    addSource(video(hex(1), 1));
    state.putProfile(hex(1), { name: "fresh" }, 10, NOW);
    const { stream, calls } = fakeStream([]);
    expect(await refreshProfiles(cfg, state, { now, stream, fetch: noFetch.fetch })).toEqual({ fetched: 0, verified: 0 });
    expect(calls).toHaveLength(0);
  });

  it("keeps a stored profile when the relay returns nothing or something older, and marks it fetched", async () => {
    addSource(video(hex(1), 1));
    addSource(video(hex(2), 2));
    const stale = NOW - 30 * DAY;
    state.putProfile(hex(1), { name: "kept" }, 500, stale);
    state.putProfile(hex(2), { name: "newer" }, 500, stale);
    const { stream } = fakeStream([profileEvent(hex(2), 100, { name: "older" })]);
    await refreshProfiles(cfg, state, { now, stream, fetch: noFetch.fetch });
    expect(state.profile(hex(1))).toEqual({ content: { name: "kept" }, createdAt: 500, fetchedAt: NOW });
    expect(state.profile(hex(2))).toEqual({ content: { name: "newer" }, createdAt: 500, fetchedAt: NOW });
  });

  it("records an empty profile for an author with none, so the next run does not ask again", async () => {
    addSource(video(hex(1), 1));
    const first = fakeStream([]);
    await refreshProfiles(cfg, state, { now, stream: first.stream, fetch: noFetch.fetch });
    expect(state.profile(hex(1))).toEqual({ content: {}, createdAt: 0, fetchedAt: NOW });
    const second = fakeStream([]);
    await refreshProfiles(cfg, state, { now, stream: second.stream, fetch: noFetch.fetch });
    expect(second.calls).toHaveLength(0);
  });

  it("ignores events from authors that were not asked for", async () => {
    addSource(video(hex(1), 1));
    const { stream } = fakeStream([profileEvent(hex(1), 100, { name: "one" })]);
    const wrapped: typeof streamEvents = async (url, filter, o, onPage) =>
      stream(url, filter, o, (events) => onPage([...events, profileEvent(hex(9), 100, { name: "stranger" })]));
    await refreshProfiles(cfg, state, { now, stream: wrapped, fetch: noFetch.fetch });
    expect(state.profile(hex(9))).toBeUndefined();
  });

  it("throws on a stalled read and stores nothing from that batch", async () => {
    addSource(video(hex(1), 1));
    const { stream } = fakeStream([profileEvent(hex(1), 100, { name: "one" })], { stalledAt: 1234 });
    await expect(refreshProfiles(cfg, state, { now, stream, fetch: noFetch.fetch })).rejects.toThrow(/1234/);
    expect(state.profile(hex(1))).toBeUndefined();
  });

  it("keeps the batches already stored when a later batch fails", async () => {
    for (let i = 1; i <= 600; i++) addSource(video(hex(i), i));
    const events = [profileEvent(hex(1), 100, { name: "first" })];
    let n = 0;
    const { stream } = fakeStream(events, { failFor: () => ++n === 2 });
    await expect(refreshProfiles(cfg, state, { now, stream, fetch: noFetch.fetch })).rejects.toThrow(/closed the connection/);
    expect(state.profile(hex(1))?.content).toEqual({ name: "first" });
    expect(state.profile(hex(550))).toBeUndefined();
  });

  it("warms the NIP-05 cache for creators and counts the handles that verified", async () => {
    addSource(video(IMR, 1));
    addSource(video(hex(2), 2));
    addSource(video(hex(3), 3));
    addSource(video(hex(4), 4), "not a Divine video");
    const { stream } = fakeStream([
      profileEvent(IMR, 100, { name: "imr", nip05: "_@imrdaviis.divine.video" }),
      profileEvent(hex(2), 100, { name: "two", nip05: "two@example.com" }),
      profileEvent(hex(3), 100, { name: "three" }),
      profileEvent(hex(4), 100, { name: "four", nip05: "four@example.com" }),
    ]);
    const { fetch, calls } = fakeFetch((url) => {
      if (url === "https://imrdaviis.divine.video/.well-known/nostr.json?name=_") return json({ names: { _: IMR } });
      if (url === "https://divine.video/.well-known/nostr.json?name=imrdaviis") return json({ names: { imrdaviis: IMR } });
      if (url === "https://example.com/.well-known/nostr.json?name=two") return json({ names: { two: OTHER } });
      return undefined;
    });
    const out = await refreshProfiles(cfg, state, { now, stream, fetch });
    expect(out).toEqual({ fetched: 3, verified: 1 });
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://divine.video/.well-known/nostr.json?name=imrdaviis",
      "https://example.com/.well-known/nostr.json?name=two",
      "https://imrdaviis.divine.video/.well-known/nostr.json?name=_",
    ]);
    const c = state.profile(IMR)!.content;
    expect(cachedNip05(IMR, c, state)).toBe("imrdaviis@divine.video");
    expect(cachedNip05(hex(2), state.profile(hex(2))!.content, state)).toBeUndefined();
    expect(state.nip05("two@example.com")).toEqual({ pubkey: OTHER, checkedAt: NOW });
    expect(state.nip05("four@example.com")).toBeUndefined();
  });

  it("does not look up again when the cache is fresh, but does when it is stale or missing", async () => {
    addSource(video(hex(1), 1));
    addSource(video(hex(2), 2));
    const ttl = cfg.profiles.nip05TtlDays * DAY;
    state.putProfile(hex(1), { nip05: "one@example.com" }, 1, NOW);
    state.putProfile(hex(2), { nip05: "two@example.com" }, 1, NOW);
    state.putNip05("one@example.com", hex(1), NOW - ttl + 100);
    state.putNip05("two@example.com", hex(2), NOW - ttl - 100);
    const { fetch, calls } = fakeFetch(() => json({ names: { one: hex(1), two: hex(2) } }));
    const { stream } = fakeStream([]);
    const out = await refreshProfiles(cfg, state, { now, stream, fetch });
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/.well-known/nostr.json?name=two"]);
    expect(out.verified).toBe(2);
  });

  it("keeps cached handles when the NIP-05 hosts are down, and a later run recovers", async () => {
    const ttl = cfg.profiles.nip05TtlDays * DAY;
    addSource(video(hex(1), 1));
    addSource(video(hex(2), 2));
    state.putProfile(hex(1), { nip05: "one@example.com" }, 1, NOW);
    state.putProfile(hex(2), { nip05: "_@two.divine.video" }, 1, NOW);
    state.putNip05("one@example.com", hex(1), NOW - ttl - 5);
    state.putNip05("_@two.divine.video", hex(2), NOW - ttl - 5);
    const down = fakeFetch(() => new Response("bad gateway", { status: 502 }));
    const { stream } = fakeStream([]);
    const out = await refreshProfiles(cfg, state, { now, stream, fetch: down.fetch });
    expect(out.verified).toBe(2);
    expect(state.nip05("one@example.com")).toEqual({ pubkey: hex(1), checkedAt: NOW - ttl - 5 });
    expect(state.nip05("_@two.divine.video")).toEqual({ pubkey: hex(2), checkedAt: NOW - ttl - 5 });
    expect(cachedNip05(hex(2), state.profile(hex(2))!.content, state)).toBe("_@two.divine.video");
  });

  it("stops asking a host after 5 unavailable answers in a row and writes nothing for the skipped ones", async () => {
    for (let i = 1; i <= 8; i++) {
      addSource(video(hex(i), i));
      state.putProfile(hex(i), { nip05: `u${i}@example.com` }, 1, NOW);
    }
    addSource(video(hex(20), 20));
    state.putProfile(hex(20), { nip05: "other@elsewhere.example" }, 1, NOW);
    const { fetch, calls } = fakeFetch((url) =>
      url.startsWith("https://example.com/") ? new Response("down", { status: 503 }) : json({ names: { other: hex(20) } }),
    );
    const { stream } = fakeStream([]);
    const out = await refreshProfiles(cfg, state, { now, stream, fetch });
    expect(calls.filter((c) => c.url.startsWith("https://example.com/"))).toHaveLength(5);
    expect(calls.filter((c) => c.url.startsWith("https://elsewhere.example/"))).toHaveLength(1);
    for (let i = 1; i <= 8; i++) expect(state.nip05(`u${i}@example.com`), String(i)).toBeUndefined();
    expect(out.verified).toBe(1);
  });

  it("counts every divine.video subdomain toward one breaker", async () => {
    for (let i = 1; i <= 9; i++) {
      addSource(video(hex(i), i));
      state.putProfile(hex(i), { nip05: `_@user${i}.divine.video` }, 1, NOW);
    }
    const { fetch, calls } = fakeFetch(() => new Error("timeout"));
    const { stream } = fakeStream([]);
    await refreshProfiles(cfg, state, { now, stream, fetch });
    expect(calls).toHaveLength(5);
  });

  it("resets the breaker count after an answer", async () => {
    for (let i = 1; i <= 12; i++) {
      addSource(video(hex(i), i));
      state.putProfile(hex(i), { nip05: `u${i}@example.com` }, 1, NOW);
    }
    // Every fifth request succeeds with a definitive answer: the run never reaches 5 failures in a row.
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n % 5 === 0 ? json({ names: {} }) : new Response("down", { status: 503 })));
    const { stream } = fakeStream([]);
    await refreshProfiles(cfg, state, { now, stream, fetch });
    expect(calls).toHaveLength(12);
  });

  it("survives a hostile NIP-05 server", async () => {
    addSource(video(hex(1), 1));
    state.putProfile(hex(1), { nip05: "one@example.com" }, 1, NOW);
    const { fetch } = fakeFetch(() => new Error("socket hang up"));
    const { stream } = fakeStream([]);
    expect(await refreshProfiles(cfg, state, { now, stream, fetch })).toEqual({ fetched: 0, verified: 0 });
  });
});
