import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { loadConfig, type Config } from "../src/config.js";
import { streamEvents, type PageOptions, type StreamResult } from "../src/source/divine-relay.js";
import { confirmFilters, sweep } from "../src/source/sweep.js";
import { sync } from "../src/source/sync.js";
import { openState, type State } from "../src/state.js";

function load(name: string): NostrEvent[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as NostrEvent);
}

const native = load("native");
const vine = load("vine");
const cfg: Config = loadConfig(new URL("../config.json", import.meta.url).pathname);
/** The Vine fixtures date from 2016, before the real `harvestSince`; this window reaches back to them. */
const cfgAll: Config = { ...cfg, source: { ...cfg.source, harvestSince: 0 } };
const OVERLAP = cfg.source.overlapSeconds;
const NOW = 1_800_000_000;

const dOf = (ev: NostrEvent) => ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
const addrOf = (ev: NostrEvent) => `${ev.pubkey}:${dOf(ev)}`;
const newest = (evs: NostrEvent[]) => Math.max(...evs.map((e) => e.created_at));

interface Call {
  url: string;
  filter: Filter;
  opts: PageOptions;
}

/**
 * A stand-in for `streamEvents` over an in-memory relay. It honours `kinds`, `since`, `authors`,
 * `#d` and `#k`, hands events over in pages of `perPage`, and can fail after `failAfterPages`
 * pages. Events in `hiddenFromWindow` are left out of any read that names no authors, as a relay
 * whose full read came back incomplete.
 */
function fakeRelay(
  events: NostrEvent[],
  {
    perPage = 20,
    failAfterPages,
    stalledAt,
    hiddenFromWindow = [],
  }: { perPage?: number; failAfterPages?: number; stalledAt?: number; hiddenFromWindow?: NostrEvent[] } = {},
) {
  const calls: Call[] = [];
  const stream: typeof streamEvents = async (url, filter, opts, onPage) => {
    calls.push({ url, filter, opts });
    const matching = events.filter((ev) => {
      if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
      if (filter.since !== undefined && ev.created_at < filter.since) return false;
      const k = filter["#k"];
      if (k && !ev.tags.some((t) => t[0] === "k" && k.includes(t[1] ?? ""))) return false;
      if (filter.authors && !filter.authors.includes(ev.pubkey)) return false;
      const d = filter["#d"];
      if (d && !ev.tags.some((t) => t[0] === "d" && d.includes(t[1] ?? ""))) return false;
      if (!filter.authors && hiddenFromWindow.includes(ev)) return false;
      return true;
    });
    const result: StreamResult = { pages: 0, events: 0, rejected: 0 };
    for (let i = 0; i < matching.length; i += perPage) {
      if (failAfterPages !== undefined && result.pages >= failAfterPages) {
        throw new Error(`the relay at ${url} closed the connection`);
      }
      const page = matching.slice(i, i + perPage);
      await onPage(page);
      result.pages++;
      result.events += page.length;
    }
    if (stalledAt !== undefined) result.stalledAt = stalledAt;
    return result;
  };
  return { stream, calls, events };
}

/** A kind 5 for a stored video, with the `e` and `a` tags Divine sends. */
function deletionOf(video: NostrEvent, over: Partial<NostrEvent> & { author?: string } = {}): NostrEvent {
  const { author, ...rest } = over;
  return {
    id: `del-${Math.random().toString(16).slice(2)}`.padEnd(64, "0"),
    pubkey: author ?? video.pubkey,
    created_at: video.created_at + 100,
    kind: 5,
    tags: [
      ["e", video.id],
      ["a", `34236:${video.pubkey}:${dOf(video)}`],
      ["k", "34236"],
    ],
    content: "",
    sig: "0".repeat(128),
    ...rest,
  };
}

function edit(video: NostrEvent, createdAt: number, title: string): NostrEvent {
  return {
    ...video,
    id: `edit-${createdAt}`.padEnd(64, "a"),
    created_at: createdAt,
    tags: video.tags.map((t) => (t[0] === "title" ? ["title", title] : [...t])),
  };
}

let state: State;
beforeEach(() => {
  state = openState(":memory:");
});
afterEach(() => {
  state.close();
});

const all = [...native, ...vine];
const sleeps: number[] = [];
const opts = (relay: ReturnType<typeof fakeRelay>) => ({
  now: () => NOW,
  stream: relay.stream,
  sleep: async (ms: number) => void sleeps.push(ms),
});

describe("sync", () => {
  it("stores 50 native rows (46 eligible) and every Vine as classic-vine, flags the first harvest and sets both cursors", async () => {
    const own = deletionOf(native[0]!, { created_at: newest(all) + 5 });
    const foreign = deletionOf(native[1]!, { author: "f".repeat(64), created_at: newest(all) + 50 });
    const relay = fakeRelay([...all, own, foreign]);
    const result = await sync(cfgAll, state, opts(relay));

    expect(result.firstHarvest).toBe(true);
    expect(result.videos).toEqual({ new: 100, updated: 0, same: 0, older: 0, rejected: 0 });
    expect(state.sources({ class: "native" })).toHaveLength(50);
    expect(state.sources({ class: "native", eligibleOnly: true })).toHaveLength(46);
    const vines = state.sources({ class: "vine" });
    expect(vines).toHaveLength(50);
    expect(vines.every((r) => r.skipReason === "classic-vine")).toBe(true);
    expect(state.sources({ class: "vine", eligibleOnly: true })).toHaveLength(0);

    expect(state.cursor("videos")).toBe(newest(all));
    // Only the author's own deletion counts toward the cursor, not the later one from another key.
    expect(state.cursor("deletions")).toBe(own.created_at);
  });

  it("asks for kind 34236 since harvestSince on a first harvest, using the configured page options and relay", async () => {
    const relay = fakeRelay(all);
    await sync(cfg, state, opts(relay));

    expect(relay.calls).toHaveLength(2);
    expect(relay.calls[0]!.url).toBe(cfg.source.relay);
    expect(relay.calls[0]!.filter).toEqual({ kinds: [34236], since: cfg.source.harvestSince });
    expect(relay.calls[0]!.opts).toMatchObject({
      pageSize: cfg.source.pageSize,
      pageDelayMs: cfg.source.pageDelayMs,
      readTimeoutMs: cfg.source.readTimeoutMs,
    });
    expect(relay.calls[1]!.filter).toEqual({ kinds: [5], "#k": ["34236"], since: cfg.source.harvestSince });
  });

  it("a second sync asks for since = cursor minus the overlap, finds nothing new and is not a first harvest", async () => {
    const relay = fakeRelay(all);
    await sync(cfgAll, state, opts(relay));
    const videosCursor = state.cursor("videos")!;
    relay.calls.length = 0;

    const second = await sync(cfgAll, state, opts(relay));

    expect(second.firstHarvest).toBe(false);
    expect(relay.calls[0]!.filter.since).toBe(videosCursor - OVERLAP);
    expect(second.videos.new).toBe(0);
    expect(second.videos.same).toBe(all.filter((e) => e.created_at >= videosCursor - OVERLAP).length);
    expect(state.sources()).toHaveLength(100);
    expect(state.cursor("videos")).toBe(videosCursor);
  });

  it("uses the deletions cursor, not the videos cursor, for the kind 5 read", async () => {
    const relay = fakeRelay(all);
    state.setCursor("videos", 5_000_000);
    state.setCursor("deletions", 7_000_000);
    const result = await sync(cfg, state, opts(relay));

    expect(result.firstHarvest).toBe(false);
    expect(relay.calls[0]!.filter.since).toBe(5_000_000 - OVERLAP);
    expect(relay.calls[1]!.filter.since).toBe(7_000_000 - OVERLAP);
  });

  it("reads one page of a long window at a time into the state", async () => {
    const relay = fakeRelay(all, { perPage: 7 });
    const result = await sync(cfgAll, state, opts(relay));
    expect(result.videos.new).toBe(100);
    expect(state.sources()).toHaveLength(100);
  });

  it("stores slimmed events, without the attestation tags", async () => {
    const heavy: NostrEvent = {
      ...native[0]!,
      tags: [...native[0]!.tags, ["proofmode", "x".repeat(1000)], ["device_attestation", "y"], ["c2pa_manifest_id", "z"]],
    };
    await sync(cfg, state, opts(fakeRelay([heavy])));
    const stored = state.source(addrOf(heavy))!.event;
    expect(stored.tags.map((t) => t[0])).not.toContain("proofmode");
    expect(stored.tags.map((t) => t[0])).not.toContain("device_attestation");
    expect(stored.tags.map((t) => t[0])).not.toContain("c2pa_manifest_id");
    expect(stored.id).toBe(heavy.id);
  });

  it("reports the signature failures the relay client counted as rejected", async () => {
    const stream: typeof streamEvents = async (_url, filter, _opts, onPage) => {
      if (filter.kinds?.[0] === 34236) {
        await onPage(native.slice(0, 3));
        return { pages: 2, events: 3, rejected: 4 };
      }
      return { pages: 1, events: 0, rejected: 2 };
    };
    const result = await sync(cfg, state, { now: () => NOW, stream });
    expect(result.videos.rejected).toBe(4);
    expect(result.videos.new).toBe(3);
  });

  describe("author deletions", () => {
    it("a kind 5 by the video's author marks it deleted", async () => {
      const victim = native[3]!;
      const relay = fakeRelay([...all, deletionOf(victim)]);
      const result = await sync(cfg, state, opts(relay));

      expect(result.deletions).toEqual({ applied: 1, ignored: 0 });
      expect(state.source(addrOf(victim))!.status).toBe("deleted");
      expect(state.sources({ status: "deleted" })).toHaveLength(1);
    });

    it("a kind 5 naming the same a tag but signed by another pubkey is ignored", async () => {
      const victim = native[3]!;
      const forged = deletionOf(victim, { author: "f".repeat(64) });
      const result = await sync(cfg, state, opts(fakeRelay([...all, forged])));

      expect(result.deletions).toEqual({ applied: 0, ignored: 1 });
      expect(state.source(addrOf(victim))!.status).toBe("active");
    });

    it("a kind 5 by another pubkey naming the stored event id is ignored", async () => {
      const victim = native[3]!;
      const other = "e".repeat(64);
      const foreign = deletionOf(victim, { author: other, tags: [["e", victim.id], ["k", "34236"]] });
      const result = await sync(cfg, state, opts(fakeRelay([...all, foreign])));

      expect(result.deletions).toEqual({ applied: 0, ignored: 1 });
      expect(state.source(addrOf(victim))!.status).toBe("active");
    });

    it("a kind 5 that names an e not matching the stored id and no a tag is ignored", async () => {
      const victim = native[3]!;
      const stale = deletionOf(victim, { tags: [["e", "0".repeat(64)], ["k", "34236"]] });
      const result = await sync(cfg, state, opts(fakeRelay([...all, stale])));
      expect(result.deletions).toEqual({ applied: 0, ignored: 1 });
      expect(state.source(addrOf(victim))!.status).toBe("active");
    });

    it("an e-only deletion of the stored event id by the author is applied", async () => {
      const victim = native[3]!;
      const eOnly = deletionOf(victim, { tags: [["e", victim.id], ["k", "34236"]] });
      const result = await sync(cfg, state, opts(fakeRelay([...native, eOnly])));

      expect(result.deletions).toEqual({ applied: 1, ignored: 0 });
      expect(state.source(addrOf(victim))!.status).toBe("deleted");
    });

    it("an e-only deletion of the stored event id by another key is ignored", async () => {
      const victim = native[3]!;
      const foreign = deletionOf(victim, { author: "d".repeat(64), tags: [["e", victim.id], ["k", "34236"]] });
      const result = await sync(cfg, state, opts(fakeRelay([...native, foreign])));

      expect(result.deletions).toEqual({ applied: 0, ignored: 1 });
      expect(state.source(addrOf(victim))!.status).toBe("active");
    });

    it("a kind 5 for an address that is not stored is ignored", async () => {
      const ghost: NostrEvent = { ...native[0]!, tags: [["d", "nothing-here"]], id: "9".repeat(64) };
      const result = await sync(cfg, state, opts(fakeRelay([...native, deletionOf(ghost)])));
      expect(result.deletions).toEqual({ applied: 0, ignored: 1 });
    });

    it("an a-only deletion that predates the stored version does not delete a newer edit", async () => {
      const victim = native[3]!;
      const old = deletionOf(victim, { created_at: victim.created_at - 10, tags: [["a", `34236:${victim.pubkey}:${dOf(victim)}`], ["k", "34236"]] });
      const result = await sync(cfg, state, opts(fakeRelay([...native, old])));
      expect(result.deletions).toEqual({ applied: 0, ignored: 1 });
      expect(state.source(addrOf(victim))!.status).toBe("active");
    });

    it("an old deletion read again in the overlap does not delete a later republish of the video", async () => {
      const victim = native[3]!;
      const del = deletionOf(victim, { created_at: victim.created_at + 100, tags: [["a", `34236:${victim.pubkey}:${dOf(victim)}`], ["k", "34236"]] });
      const first = fakeRelay([...native, del]);
      await sync(cfg, state, opts(first));
      expect(state.source(addrOf(victim))!.status).toBe("deleted");

      const republished = edit(victim, victim.created_at + 500, "Back again");
      const second = fakeRelay([...native.filter((e) => e !== victim), republished, del]);
      const result = await sync(cfg, state, opts(second));

      expect(result.videos.updated).toBe(1);
      expect(result.deletions.applied).toBe(0);
      expect(state.source(addrOf(victim))!.status).toBe("active");
    });

    it("a deletion applied on one sync is not counted again when the overlap re-reads it", async () => {
      const victim = native[3]!;
      const relay = fakeRelay([...native, deletionOf(victim)]);
      await sync(cfg, state, opts(relay));
      const again = await sync(cfg, state, opts(relay));

      expect(again.deletions).toEqual({ applied: 0, ignored: 1 });
      expect(state.source(addrOf(victim))!.status).toBe("deleted");
    });

    it("a video read in the same sync as its deletion is stored, then deleted", async () => {
      const victim = native[0]!;
      const relay = fakeRelay([victim, deletionOf(victim)], { perPage: 1 });
      const result = await sync(cfg, state, opts(relay));
      expect(result.videos.new).toBe(1);
      expect(result.deletions.applied).toBe(1);
      expect(state.source(addrOf(victim))!.status).toBe("deleted");
    });
  });

  describe("a source that drops mid-read", () => {
    it("rejecting after one page of videos leaves both cursors unchanged and the next sync re-reads from the old cursor", async () => {
      const seeded = native.slice(0, 5);
      await sync(cfg, state, opts(fakeRelay(seeded)));
      const videosBefore = state.cursor("videos")!;
      const deletionsBefore = state.cursor("deletions");

      const later = native.slice(5).map((e, i) => ({ ...e, created_at: videosBefore + 10 + i }));
      const flaky = fakeRelay([...seeded, ...later], { perPage: 10, failAfterPages: 1 });
      await expect(sync(cfg, state, opts(flaky))).rejects.toThrow(/closed the connection/);

      expect(state.cursor("videos")).toBe(videosBefore);
      expect(state.cursor("deletions")).toBe(deletionsBefore);
      expect(state.sources().length).toBeGreaterThan(5);

      const healthy = fakeRelay([...seeded, ...later]);
      const result = await sync(cfg, state, opts(healthy));
      expect(healthy.calls[0]!.filter.since).toBe(videosBefore - OVERLAP);
      expect(result.firstHarvest).toBe(false);
      expect(state.sources()).toHaveLength(50);
      expect(state.cursor("videos")).toBe(newest(later));
    });

    it("a first harvest that drops after one page sets no cursor, so the retry is a first harvest again", async () => {
      const flaky = fakeRelay(native, { perPage: 10, failAfterPages: 1 });
      await expect(sync(cfg, state, opts(flaky))).rejects.toThrow();
      expect(state.cursor("videos")).toBeUndefined();
      expect(state.cursor("deletions")).toBeUndefined();

      const healthy = fakeRelay(native);
      const result = await sync(cfg, state, opts(healthy));
      expect(result.firstHarvest).toBe(true);
      expect(healthy.calls[0]!.filter.since).toBe(cfg.source.harvestSince);
      expect(state.sources()).toHaveLength(50);
    });

    it("a drop during the deletions read keeps the new videos cursor but not the deletions cursor", async () => {
      const victim = native[0]!;
      const del = deletionOf(victim);
      const stream: typeof streamEvents = async (url, filter, o, onPage) => {
        if (filter.kinds?.[0] === 34236) return fakeRelay(native).stream(url, filter, o, onPage);
        await onPage([del]);
        throw new Error("the relay at wss://x closed the connection");
      };
      await expect(sync(cfg, state, { now: () => NOW, stream })).rejects.toThrow();

      expect(state.cursor("videos")).toBe(newest(native));
      expect(state.cursor("deletions")).toBeUndefined();

      // The page that arrived before the drop was committed, so the retry finds the deletion done.
      expect(state.source(addrOf(victim))!.status).toBe("deleted");
      const result = await sync(cfg, state, opts(fakeRelay([...native, del])));
      expect(result.firstHarvest).toBe(false);
      expect(result.deletions).toEqual({ applied: 0, ignored: 1 });
      expect(state.cursor("deletions")).toBe(del.created_at);
    });

    it("a page whose writes fail rolls back as one and moves no cursor", async () => {
      const bad: NostrEvent = { ...native[1]!, tags: undefined as unknown as string[][] };
      const relay = fakeRelay([native[0]!, bad], { perPage: 10 });
      await expect(sync(cfg, state, opts(relay))).rejects.toThrow();
      expect(state.sources()).toHaveLength(0);
      expect(state.cursor("videos")).toBeUndefined();
    });
  });

  describe("a window the relay could not page through", () => {
    it("a stalled videos read throws and sets no cursor", async () => {
      const relay = fakeRelay(native, { stalledAt: 1_791_560_000 });
      await expect(sync(cfg, state, opts(relay))).rejects.toThrow(/more events at second 1791560000 than fit in one page/);
      expect(state.cursor("videos")).toBeUndefined();
      expect(state.cursor("deletions")).toBeUndefined();
      expect(relay.calls).toHaveLength(1);
    });

    it("a stalled deletions read throws and sets no deletions cursor", async () => {
      const victim = native[0]!;
      const del = deletionOf(victim);
      const stream: typeof streamEvents = async (url, filter, o, onPage) => {
        const r = await fakeRelay([...native, del]).stream(url, filter, o, onPage);
        return filter.kinds?.[0] === 5 ? { ...r, stalledAt: del.created_at } : r;
      };
      await expect(sync(cfg, state, { now: () => NOW, stream })).rejects.toThrow(/than fit in one page/);
      expect(state.cursor("deletions")).toBeUndefined();
    });
  });

  describe("future-dated events", () => {
    it("a video dated in the future does not push the videos cursor beyond now", async () => {
      const future: NostrEvent = { ...native[0]!, id: "c".repeat(64), tags: [["d", "from-2099"], ...native[0]!.tags.filter((t) => t[0] !== "d")], created_at: 4_000_000_000 };
      await sync(cfg, state, opts(fakeRelay([...native, future])));
      expect(state.cursor("videos")).toBe(NOW);
      expect(state.source(addrOf(future))).toBeDefined();
    });

    it("an ignored future-dated kind 5 from another key does not move the deletions cursor", async () => {
      const victim = native[3]!;
      const own = deletionOf(victim);
      const hostile = deletionOf(victim, { author: "f".repeat(64), created_at: 4_000_000_000 });
      await sync(cfg, state, opts(fakeRelay([...native, own, hostile])));
      expect(state.cursor("deletions")).toBe(own.created_at);
    });

    it("an author's own future-dated kind 5 is clamped to now", async () => {
      const victim = native[3]!;
      const own = deletionOf(victim, { created_at: 4_000_000_000 });
      await sync(cfg, state, opts(fakeRelay([...native, own])));
      expect(state.cursor("deletions")).toBe(NOW);
    });
  });

  describe("edits", () => {
    it("a newer edit of a video replaces the stored event", async () => {
      const video = native[2]!;
      await sync(cfg, state, opts(fakeRelay(native)));
      const edited = edit(video, newest(native) + 60, "A better title");

      const result = await sync(cfg, state, opts(fakeRelay([...native, edited])));

      expect(result.videos.updated).toBe(1);
      expect(result.videos.new).toBe(0);
      const row = state.source(addrOf(video))!;
      expect(row.eventId).toBe(edited.id);
      expect(row.event.tags.find((t) => t[0] === "title")?.[1]).toBe("A better title");
      expect(state.cursor("videos")).toBe(edited.created_at);
    });

    it("an older version arriving later is counted as older and changes nothing", async () => {
      const video = native[2]!;
      const edited = edit(video, video.created_at + 60, "Newest");
      await sync(cfg, state, opts(fakeRelay([edited])));

      const result = await sync(cfg, state, opts(fakeRelay([video])));
      expect(result.videos.older).toBe(1);
      expect(state.source(addrOf(video))!.eventId).toBe(edited.id);
    });

    it("never moves a cursor backwards", async () => {
      state.setCursor("videos", newest(native) + 1000);
      await sync(cfg, state, opts(fakeRelay(native)));
      expect(state.cursor("videos")).toBe(newest(native) + 1000);
    });
  });

  it("leaves the cursors alone when nothing was read", async () => {
    const result = await sync(cfg, state, opts(fakeRelay([])));
    expect(result.firstHarvest).toBe(true);
    expect(state.cursor("videos")).toBeUndefined();
    expect(state.cursor("deletions")).toBeUndefined();
  });
});

describe("sweep", () => {
  beforeEach(async () => {
    await sync(cfgAll, state, opts(fakeRelay(all)));
  });

  it("asks for the whole native window since harvestSince", async () => {
    const relay = fakeRelay(all);
    await sweep(cfg, state, opts(relay));
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]!.url).toBe(cfg.source.relay);
    expect(relay.calls[0]!.filter).toEqual({ kinds: [34236], since: cfg.source.harvestSince });
  });

  it("marks nothing vanished when every video is present, and sets last_sweep", async () => {
    const result = await sweep(cfgAll, state, opts(fakeRelay(all)));
    expect(result).toEqual({ seen: 100, vanished: [], upserted: 0 });
    expect(state.sources({ status: "vanished" })).toHaveLength(0);
    expect(state.cursor("last_sweep")).toBe(NOW);
  });

  it("with 49 of 50 native videos present marks exactly the missing one vanished, after asking for it by name", async () => {
    const missing = native[7]!;
    const relay = fakeRelay(all.filter((e) => e !== missing), { perPage: 9 });
    sleeps.length = 0;
    const result = await sweep(cfgAll, state, opts(relay));

    expect(relay.calls).toHaveLength(2);
    expect(relay.calls[1]!.filter).toEqual({ kinds: [34236], authors: [missing.pubkey], "#d": [dOf(missing)] });
    expect(sleeps).toEqual([cfg.source.pageDelayMs]);
    expect(result.seen).toBe(99);
    expect(result.vanished).toEqual([addrOf(missing)]);
    expect(state.sources({ status: "vanished" }).map((r) => r.address)).toEqual([addrOf(missing)]);
    expect(state.sources({ status: "active" })).toHaveLength(99);
    expect(state.cursor("last_sweep")).toBe(NOW);
  });

  it("does not mark Vine rows vanished when they are absent, since only the native window is checked", async () => {
    const result = await sweep(cfg, state, opts(fakeRelay(native)));
    expect(result.vanished).toEqual([]);
    expect(state.sources({ class: "vine", status: "active" })).toHaveLength(50);
  });

  it("counts a video as seen when its stored version is newer than the relay's (older upsert path)", async () => {
    const video = native[4]!;
    const edited = edit(video, video.created_at + 60, "Newer");
    await sync(cfg, state, opts(fakeRelay([edited])));

    const result = await sweep(cfg, state, { now: () => NOW + 10, stream: fakeRelay(all).stream });
    expect(result.vanished).toEqual([]);
    expect(state.source(addrOf(video))!.status).toBe("active");
  });

  it("brings a vanished video back when a later sweep sees it", async () => {
    const missing = native[7]!;
    await sweep(cfg, state, opts(fakeRelay(all.filter((e) => e !== missing))));
    expect(state.source(addrOf(missing))!.status).toBe("vanished");

    const result = await sweep(cfg, state, opts(fakeRelay(all)));
    expect(result.vanished).toEqual([]);
    expect(state.source(addrOf(missing))!.status).toBe("active");
  });

  it("leaves deleted videos alone", async () => {
    const gone = native[9]!;
    state.setSourceStatus(addrOf(gone), "deleted", NOW);
    const result = await sweep(cfg, state, opts(fakeRelay(all.filter((e) => e !== gone))));
    expect(result.vanished).toEqual([]);
    expect(state.source(addrOf(gone))!.status).toBe("deleted");
  });

  it("a sweep that rejects marks nothing vanished and sets no last_sweep", async () => {
    const result = sweep(cfg, state, opts(fakeRelay(native.slice(0, 5), { perPage: 2, failAfterPages: 1 })));
    await expect(result).rejects.toThrow(/closed the connection/);

    expect(state.sources({ status: "vanished" })).toHaveLength(0);
    expect(state.sources({ status: "active" })).toHaveLength(100);
    expect(state.cursor("last_sweep")).toBeUndefined();
  });

  it("a stalled sweep throws, marks nothing vanished and sets no last_sweep", async () => {
    const relay = fakeRelay(native.slice(0, 40), { stalledAt: 1_791_560_000 });
    await expect(sweep(cfgAll, state, opts(relay))).rejects.toThrow(/than fit in one page/);

    expect(state.sources({ status: "vanished" })).toHaveLength(0);
    expect(state.cursor("last_sweep")).toBeUndefined();
  });

  it("a sweep that sees no video at all throws, marks nothing vanished and sets no last_sweep", async () => {
    await expect(sweep(cfg, state, opts(fakeRelay([])))).rejects.toThrow(
      /read no videos .* while state holds 50 active native videos.*nothing was marked vanished; run npm run sweep again later/,
    );
    expect(state.sources({ status: "vanished" })).toHaveLength(0);
    expect(state.cursor("last_sweep")).toBeUndefined();
  });

  it("a sweep that would mark more than maxVanishedFraction vanished throws and marks nothing", async () => {
    // 3 of 50 is 6%, over the 5% default.
    const gone = new Set(native.slice(0, 3));
    const relay = fakeRelay(all.filter((e) => !gone.has(e)));
    await expect(sweep(cfgAll, state, opts(relay))).rejects.toThrow(
      /would mark 3 of 50 active native videos vanished, more than the 5% limit .*run npm run sweep again later/,
    );
    expect(relay.calls).toHaveLength(1);
    expect(state.sources({ status: "vanished" })).toHaveLength(0);
    expect(state.cursor("last_sweep")).toBeUndefined();

    // At the limit it marks them.
    const two = new Set(native.slice(0, 2));
    const ok = await sweep(cfgAll, state, opts(fakeRelay(all.filter((e) => !two.has(e)))));
    expect(ok.vanished).toHaveLength(2);
  });

  it("does not mark an address the full read missed but the check by name finds", async () => {
    const [hidden, gone] = [native[3]!, native[8]!];
    const relay = fakeRelay(all.filter((e) => e !== gone), { hiddenFromWindow: [hidden] });
    const result = await sweep(cfgAll, state, opts(relay));

    expect(result.vanished).toEqual([addrOf(gone)]);
    expect(state.source(addrOf(hidden))!.status).toBe("active");
    expect(state.source(addrOf(gone))!.status).toBe("vanished");
    const named = relay.calls[1]!.filter;
    expect(new Set(named.authors)).toEqual(new Set([hidden.pubkey, gone.pubkey]));
    expect(new Set(named["#d"])).toEqual(new Set([dOf(hidden), dOf(gone)]));
  });

  it("asks for missing addresses in filters of at most 500 authors and 500 d values", () => {
    const addresses = Array.from({ length: 1201 }, (_, i) => `${(i % 700).toString(16).padStart(64, "0")}:vid-${i}`).sort();
    const filters = confirmFilters(addresses);
    expect(filters).toHaveLength(3);
    const covered = new Set<string>();
    for (const f of filters) {
      expect(f.kinds).toEqual([34236]);
      expect(f.authors!.length).toBeLessThanOrEqual(500);
      expect(f["#d"]!.length).toBeLessThanOrEqual(500);
      for (const a of f.authors!) for (const d of f["#d"]!) covered.add(`${a}:${d}`);
    }
    for (const address of addresses) expect(covered.has(address)).toBe(true);
  });

  it("stores an event it reads that state does not hold, or holds an older version of", async () => {
    const unknown: NostrEvent = { ...native[0]!, id: "u".padEnd(64, "1"), pubkey: "9".repeat(64) };
    const video = native[5]!;
    const edited = edit(video, video.created_at + 30, "Edited after sync");
    const relay = fakeRelay([...all.filter((e) => e !== video), edited, unknown]);
    const result = await sweep(cfgAll, state, opts(relay));

    expect(result.upserted).toBe(2);
    expect(state.source(addrOf(unknown))).toMatchObject({ status: "active", class: "native", skipReason: null });
    expect(state.source(addrOf(video))!.event.tags.find((t) => t[0] === "title")![1]).toBe("Edited after sync");
    expect(state.source(addrOf(unknown))!.event.tags.some((t) => t[0] === "proofmode")).toBe(false);
  });
});
