import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build, runDirFor, type BuildOptions } from "../src/commands/build.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Unsigned } from "../src/deletion.js";
import { contentHash } from "../src/diff.js";
import { buildItem, itemD } from "../src/item.js";
import { thumbnailUrl, videoUrl, type MediaRunResult } from "../src/media.js";
import { classOf, imeta, skipReason, slim } from "../src/source/classify.js";
import type { SyncResult } from "../src/source/sync.js";
import { openState, type State } from "../src/state.js";
import type { Tags } from "../src/tags.js";

function load(name: string): NostrEvent[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as NostrEvent);
}

const native = load("native");
const vine = load("vine");
const header = JSON.parse(readFileSync("tests/fixtures/live-header.json", "utf8")) as NostrEvent;
const base: Config = loadConfig(new URL("../config.json", import.meta.url).pathname);
const NOW = 1_800_000_000;
const NO_RELAY = "ws://127.0.0.1:9";

const eligible = native.filter((ev) => skipReason(ev, base.scope) === null);
const dOf = (ev: NostrEvent) => ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
const addrOf = (ev: NostrEvent) => `${ev.pubkey}:${dOf(ev)}`;
const tag = (tags: Tags, name: string) => tags.find((t) => t[0] === name)?.[1];

let dir: string;
let cfg: Config;
let state: State;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divinebot-build-"));
  cfg = {
    ...base,
    // Loopback only: a test that reached the header read without an injected header fails here.
    relays: { dcosl: NO_RELAY, search: NO_RELAY },
    paths: { out: join(dir, "out"), state: ":memory:" },
  };
  state = openState(":memory:");
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(events: NostrEvent[] = [...native, ...vine]): void {
  for (const ev of events) state.upsertSource(slim(ev), classOf(ev), skipReason(ev, cfg.scope), NOW);
}

function thumbOf(ev: NostrEvent): string | undefined {
  const image = imeta(ev)?.image;
  return image?.startsWith("https://") ? image : undefined;
}

function passMedia(events: NostrEvent[] = eligible): void {
  for (const ev of events) {
    state.putMedia(videoUrl(imeta(ev)!.x!, cfg.media.base), "pass", 200, "video/mp4", NOW);
    const thumb = thumbOf(ev);
    if (thumb) state.putMedia(thumb, "pass", 200, "image/jpeg", NOW);
  }
}

/** Sources seeded from every fixture, media passed for every eligible one. */
function seedAll(): void {
  seed();
  passMedia();
}

function run(opts: BuildOptions = {}) {
  return build(cfg, state, { header, firstRun: true, now: () => NOW, ...opts });
}

function lines(runDir: string): Unsigned[] {
  return readFileSync(join(runDir, "unsigned.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Unsigned);
}

const eventId = (d: string, version = 0) => contentHash([["v", d, String(version)]]);

/** Records every item of a run as published and live, as publish would. */
function publishAll(runDir: string): void {
  for (const ev of lines(runDir)) {
    if (ev.kind !== 39999) continue;
    const d = tag(ev.tags, "d")!;
    const id = eventId(d);
    state.recordResult({ eventId: id, d, kind: 39999, createdAt: NOW, runId: basename(runDir), relay: "dcosl", ok: true, message: "" });
    const address = tag(ev.tags, "a")!.split(":").slice(1).join(":");
    state.markLive(d, contentHash(ev.tags), JSON.stringify(ev.tags), id, NOW, address);
  }
}

async function publishedState(): Promise<void> {
  seedAll();
  publishAll((await run({ runId: "first" })).runDir);
}

const media = (over: Partial<MediaRunResult> = {}): MediaRunResult => ({
  checked: 0,
  passed: 0,
  failed: 0,
  inconclusive: 0,
  outage: false,
  ...over,
});

const sync = (videos: Partial<SyncResult["videos"]> = {}): SyncResult => ({
  videos: { new: 0, updated: 0, same: 0, older: 0, rejected: 0, ...videos },
  deletions: { applied: 0, ignored: 0 },
  firstHarvest: false,
});

describe("build", () => {
  it("first build creates one item per eligible native source and no deletions", async () => {
    seedAll();
    const result = await run({ runId: "r1" });

    expect(result.runDir).toBe(join(cfg.paths.out, "r1"));
    expect(result).toMatchObject({ created: eligible.length, changed: 0, unchanged: 0, deletions: 0, breaches: [] });
    const events = lines(result.runDir);
    expect(events).toHaveLength(46);
    for (const e of events) {
      expect(Object.keys(e)).toEqual(["kind", "tags", "content"]);
      expect(e.kind).toBe(39999);
      expect(e.content).toBe("");
    }
    const ds = events.map((e) => tag(e.tags, "d")!);
    expect(ds).toEqual(eligible.map(itemD).sort());
    expect(existsSync(join(result.runDir, "report.md"))).toBe(true);
    expect(existsSync(join(result.runDir, "manifest.json"))).toBe(true);
  });

  it("builds each item with the creator name and cached NIP-05 handle from state", async () => {
    seedAll();
    const ev = eligible[0]!;
    state.putProfile(ev.pubkey, { name: "Someone", nip05: "someone@example.com" }, NOW, NOW);
    state.putNip05("someone@example.com", ev.pubkey, NOW);
    const { runDir } = await run({ runId: "r1" });
    const item = lines(runDir).find((e) => tag(e.tags, "d") === itemD(ev))!;
    expect(item.tags).toEqual(
      buildItem(slim(ev), {
        headerCoordinate: cfg.headerCoordinate,
        mediaBase: cfg.media.base,
        creator: "Someone",
        nip05: "someone@example.com",
      }),
    );
  });

  it("refuses a state with no items unless firstRun is set", async () => {
    seedAll();
    await expect(build(cfg, state, { header, runId: "r1", now: () => NOW })).rejects.toThrow(/--first-run/);
    expect(existsSync(join(cfg.paths.out, "r1"))).toBe(false);
  });

  it("never overwrites a run", async () => {
    seedAll();
    mkdirSync(join(cfg.paths.out, "r1"), { recursive: true });
    await expect(run({ runId: "r1" })).rejects.toThrow(/already exists/);
  });

  it("refuses a run id that is not a plain directory name", () => {
    expect(() => runDirFor(cfg, "../x")).toThrow(/plain directory name/);
    expect(runDirFor(cfg, "20261009T120000Z")).toBe(join(cfg.paths.out, "20261009T120000Z"));
  });

  it("names the run by UTC time from now, with -pilot for a pilot build", async () => {
    seedAll();
    const full = await run();
    expect(basename(full.runDir)).toBe("20270115T080000Z");
    const pilot = await run({ pilot: 1, now: () => NOW + 1 });
    expect(basename(pilot.runDir)).toBe("20270115T080001Z-pilot");
  });

  it("a second build with no changes writes zero lines", async () => {
    await publishedState();
    const second = await run({ runId: "r2", firstRun: false });
    expect(readFileSync(join(second.runDir, "unsigned.jsonl"), "utf8")).toBe("");
    expect(second).toMatchObject({ created: 0, changed: 0, unchanged: 46, deletions: 0 });
  });

  it("writes a changed item when the creator's profile name changes", async () => {
    await publishedState();
    const ev = eligible[0]!;
    state.putProfile(ev.pubkey, { display_name: "New Name" }, NOW, NOW);
    const sameCreator = eligible.filter((e) => e.pubkey === ev.pubkey).length;
    const result = await run({ runId: "r2" });
    expect(result).toMatchObject({ created: 0, changed: sameCreator, deletions: 0 });
    const events = lines(result.runDir);
    expect(events.every((e) => e.kind === 39999 && tag(e.tags, "creator") === "New Name")).toBe(true);
    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    expect(report).toMatch(/\| creator \| \d+ \|/);
  });

  it("marking one source deleted produces one kind 5 naming every recorded version", async () => {
    await publishedState();
    const ev = eligible[3]!;
    const d = itemD(ev);
    // An earlier version too, so the deletion must name both.
    state.recordResult({ eventId: eventId(d, 1), d, kind: 39999, createdAt: NOW - 10, runId: "older", relay: "search", ok: true, message: "" });
    state.setSourceStatus(addrOf(ev), "deleted", NOW);

    const result = await run({ runId: "r2" });
    expect(result).toMatchObject({ created: 0, changed: 0, deletions: 1, unchanged: 45 });
    const events = lines(result.runDir);
    expect(events).toHaveLength(1);
    const del = events[0]!;
    expect(del.kind).toBe(5);
    expect(state.versionsOf(d)).toHaveLength(2);
    expect(del.tags.filter((t) => t[0] === "e").map((t) => t[1])).toEqual(state.versionsOf(d));
    expect(del.tags).toContainEqual(["a", `39999:${cfg.curatorPubkey}:${d}`]);
    expect(del.tags).toContainEqual(["k", "39999"]);
  });

  it("deletes items whose source vanished, became ineligible or left state", async () => {
    await publishedState();
    const [a, b] = eligible;
    state.setSourceStatus(addrOf(a!), "vanished", NOW);
    state.upsertSource(slim(b!), "native", "content-warning", NOW);
    state.markLive("divine-orphan", "hash", "[]", eventId("divine-orphan"), NOW, `${"f".repeat(64)}:orphan`);

    const result = await run({ runId: "r2" });
    const deleted = lines(result.runDir).map((e) => e.tags.find((t) => t[0] === "a")![1]);
    expect(deleted).toEqual(
      [itemD(a!), itemD(b!), "divine-orphan"].sort().map((d) => `39999:${cfg.curatorPubkey}:${d}`),
    );
    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    expect(report).toMatch(/vanished/);
    expect(report).toMatch(/content-warning/);
  });

  it("a failed thumbnail media row excludes that item and deletes it once live", async () => {
    seed();
    passMedia();
    const ev = eligible.find((e) => thumbOf(e) !== undefined)!;
    state.putMedia(thumbOf(ev)!, "fail", 404, "", NOW);
    const first = await run({ runId: "r1" });
    expect(first.created).toBe(45);
    expect(first.skipped["media-failed"]).toBe(1);
    expect(lines(first.runDir).some((e) => tag(e.tags, "d") === itemD(ev))).toBe(false);

    // Once listed, a later fail deletes it.
    state.putMedia(thumbOf(ev)!, "pass", 200, "image/jpeg", NOW);
    publishAll((await run({ runId: "r2" })).runDir);
    state.putMedia(videoUrl(imeta(ev)!.x!, cfg.media.base), "fail", 410, "", NOW);
    const later = await run({ runId: "r3" });
    expect(later.deletions).toBe(1);
    expect(lines(later.runDir)[0]!.tags).toContainEqual(["a", `39999:${cfg.curatorPubkey}:${itemD(ev)}`]);
  });

  it("builds a video with no https thumbnail on its video row alone, without a thumbnail tag", async () => {
    const ev = eligible[0]!;
    const noThumb: NostrEvent = {
      ...ev,
      tags: ev.tags.map((t) => (t[0] === "imeta" ? t.filter((v) => !v.startsWith("image ")) : t)),
    };
    seed([noThumb]);
    state.putMedia(videoUrl(imeta(ev)!.x!, cfg.media.base), "pass", 200, "video/mp4", NOW);
    const result = await run({ runId: "r1" });
    expect(result.created).toBe(1);
    expect(tag(lines(result.runDir)[0]!.tags, "thumbnail")).toBeUndefined();
  });

  it("treats an unparseable https:// image as no thumbnail: built on the video row alone, without a thumbnail tag", async () => {
    const ev = eligible[0]!;
    const bad = ["https://", "https://exa mple.com/a.jpg"].map((image, i): NostrEvent => ({
      ...ev,
      id: contentHash([["bad-image", String(i)]]),
      pubkey: (i + 1).toString(16).padStart(64, "0"),
      tags: ev.tags.map((t) => (t[0] === "imeta" ? t.map((v) => (v.startsWith("image ") ? `image ${image}` : v)) : t)),
    }));
    seed(bad);
    state.putMedia(videoUrl(imeta(ev)!.x!, cfg.media.base), "pass", 200, "video/mp4", NOW);
    const result = await run({ runId: "r1" });
    expect(result.created).toBe(2);
    expect(result.skipped["media-pending"]).toBeUndefined();
    for (const item of lines(result.runDir)) expect(tag(item.tags, "thumbnail")).toBeUndefined();
  });

  it("needs and writes the thumbnail only as thumbnailUrl gives it: U+00A0 and U+FEFF images are none, a padded one is exact", async () => {
    const ev = eligible[0]!;
    const make = (image: string, i: number): NostrEvent => ({
      ...ev,
      id: contentHash([["image", String(i)]]),
      pubkey: (i + 1).toString(16).padStart(64, "0"),
      tags: ev.tags.map((t) => (t[0] === "imeta" ? t.map((v) => (v.startsWith("image ") ? `image ${image}` : v)) : t)),
    });
    const nbsp = make("\u00a0https://example.com/a.jpg", 0);
    const bom = make("\ufeffhttps://example.com/b.jpg", 1);
    const padded = make("  https://example.com/c.jpg  ", 2);
    seed([nbsp, bom, padded]);
    state.putMedia(videoUrl(imeta(ev)!.x!, cfg.media.base), "pass", 200, "video/mp4", NOW);

    // Video row alone: the first two are built without a thumbnail; the padded one waits for its thumbnail row.
    const first = await run({ runId: "r1" });
    expect(lines(first.runDir).map((e) => [tag(e.tags, "d"), tag(e.tags, "thumbnail")])).toEqual(
      [itemD(nbsp), itemD(bom)].sort().map((d) => [d, undefined]),
    );
    expect(first.skipped["media-pending"]).toBe(1);

    // A pass row under the exact padded string builds it, writing that same string.
    state.putMedia(thumbnailUrl(padded)!, "pass", 200, "image/jpeg", NOW);
    const second = await run({ runId: "r2" });
    const item = lines(second.runDir).find((e) => tag(e.tags, "d") === itemD(padded))!;
    expect(tag(item.tags, "thumbnail")).toBe("  https://example.com/c.jpg  ");
  });

  it("holds a video whose media checks are pending: not built new, and a live item is kept as it is", async () => {
    seed();
    passMedia(eligible.slice(2));
    const [pendingNew, pendingLive] = eligible;
    // A live item whose source has no media rows, with tags that differ from a fresh build.
    state.markLive(itemD(pendingLive!), "stale-hash", "[]", eventId(itemD(pendingLive!)), NOW, addrOf(pendingLive!));
    state.recordResult({ eventId: eventId(itemD(pendingLive!)), d: itemD(pendingLive!), kind: 39999, createdAt: NOW, runId: "x", relay: "dcosl", ok: true, message: "" });

    const result = await run({ runId: "r1", firstRun: false });
    const ds = lines(result.runDir).map((e) => tag(e.tags, "d"));
    expect(ds).not.toContain(itemD(pendingNew!));
    expect(ds).not.toContain(itemD(pendingLive!));
    expect(result).toMatchObject({ created: 44, changed: 0, deletions: 0 });
    expect(result.skipped["media-pending"]).toBe(1);
    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    expect(report).toMatch(/\| media-pending \| 1 \|/);
    expect(report).toMatch(/1 live item is kept as it is/);
  });

  it("a media outage makes no deletions and records the breach", async () => {
    await publishedState();
    // media.ts stored no failures for the outage run, so every row is still a pass.
    const result = await run({ runId: "r2", media: media({ checked: 100, failed: 95, passed: 5, outage: true }) });
    expect(result.deletions).toBe(0);
    expect(readFileSync(join(result.runDir, "unsigned.jsonl"), "utf8")).toBe("");
    expect(result.breaches.map((b) => b.guard)).toEqual(["mediaOutage"]);
  });

  it("a pilot build writes only new items chosen by selectPilot, never changed items or deletions", async () => {
    await publishedState();
    const fresh = native.find((ev) => skipReason(ev, cfg.scope) === null)!;
    // Every fixture item is live, so new candidates come from six more creators.
    const extra: NostrEvent[] = Array.from({ length: 6 }, (_, i) => ({
      ...fresh,
      id: contentHash([["extra", String(i)]]),
      pubkey: i.toString(16).padStart(64, "0"),
    }));
    seed(extra);
    passMedia(extra);
    state.setSourceStatus(addrOf(eligible[5]!), "deleted", NOW);
    state.putProfile(eligible[6]!.pubkey, { display_name: "Changed" }, NOW, NOW);

    const result = await run({ runId: "p1", pilot: 4 });
    const events = lines(result.runDir);
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.kind === 39999)).toBe(true);
    const extraDs = new Set(extra.map(itemD));
    expect(events.every((e) => extraDs.has(tag(e.tags, "d")!))).toBe(true);
    expect(result).toMatchObject({ created: 4, changed: 0, deletions: 0 });

    const again = await run({ runId: "p2", pilot: 4 });
    expect(lines(again.runDir)).toEqual(events);
  });

  it("refuses a pilot size that is not a positive integer", async () => {
    seedAll();
    await expect(run({ runId: "r1", pilot: 0 })).rejects.toThrow(/pilot/);
    await expect(run({ runId: "r2", pilot: 1.5 })).rejects.toThrow(/pilot/);
  });

  it("report.md lists skip reasons with counts", async () => {
    seedAll();
    const { runDir, skipped } = await run({ runId: "r1" });
    expect(skipped).toMatchObject({ "no-title": 3, expiration: 1 });
    const report = readFileSync(join(runDir, "report.md"), "utf8");
    expect(report).toMatch(/## Skipped/);
    expect(report).toMatch(/\| no-title \| 3 \|/);
    expect(report).toMatch(/\| expiration \| 1 \|/);
    expect(report).toMatch(/## Guards/);
    expect(report).toMatch(/## Sample items/);
    expect(report).not.toMatch(/—/);
  });

  it("counts a source whose item cannot be built as build-error, names it in the report and writes the rest", async () => {
    seedAll();
    // A row stored as eligible whose event has no title: buildItem throws for it.
    const ev = eligible[0]!;
    const broken: NostrEvent = {
      ...ev,
      id: contentHash([["broken"]]),
      pubkey: "ab".repeat(32),
      tags: ev.tags.filter((t) => t[0] !== "title" && t[0] !== "summary"),
    };
    state.upsertSource(slim(broken), "native", null, NOW);

    const result = await run({ runId: "r1" });
    expect(result.skipped["build-error"]).toBe(1);
    expect(result.created).toBe(eligible.length);
    expect(lines(result.runDir)).toHaveLength(eligible.length);
    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    expect(report).toMatch(/\| build-error \| 1 \|/);
    expect(report).toContain(addrOf(broken));
    expect(report).toContain("has no title");
  });

  it("drops the description of an item over the size limit, and skips the source as too-large when that is not enough", async () => {
    const ev = eligible[0]!;
    const make = (i: number, tags: string[][]): NostrEvent => ({
      ...ev,
      id: contentHash([["big", String(i)]]),
      pubkey: (i + 1).toString(16).padStart(64, "0"),
      tags,
    });
    const big = "a".repeat(300_000);
    const longSummary = make(0, [...ev.tags.filter((t) => t[0] !== "summary"), ["summary", big]]);
    const longTitle = make(1, [...ev.tags.filter((t) => t[0] !== "title"), ["title", big]]);
    seed([longSummary, longTitle]);
    passMedia([longSummary, longTitle]);

    const result = await run({ runId: "r1" });
    expect(result.created).toBe(1);
    expect(result.skipped["too-large"]).toBe(1);
    const [item] = lines(result.runDir);
    expect(tag(item!.tags, "d")).toBe(itemD(longSummary));
    expect(tag(item!.tags, "description")).toBeUndefined();
    expect(tag(item!.tags, "title")).toBe(tag(ev.tags, "title"));
    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    expect(report).toMatch(/\| too-large \| 1 \|/);
  });

  it("writes manifest.json with the config identity, counts and breaches", async () => {
    seedAll();
    const { runDir } = await run({ runId: "r1", vanished: 5 });
    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      runId: "r1",
      config: { headerCoordinate: cfg.headerCoordinate, curatorPubkey: cfg.curatorPubkey },
      headerEventId: header.id,
      options: { pilot: null, firstRun: true },
      counts: { created: 46, changed: 0, unchanged: 0, deletions: 0 },
    });
    // 5 vanished of 0 live items trips the guard; the run is still written.
    expect(manifest.breaches).toEqual([expect.objectContaining({ guard: "maxVanished", actual: 5 })]);
  });

  describe("sourceEmpty", () => {
    it("trips when sync read no videos while state holds active ones from the week before the cursor", async () => {
      seedAll();
      const newestNative = Math.max(...native.map((e) => e.created_at));
      state.setCursor("videos", newestNative);
      const result = await run({ runId: "r1", sync: sync({ rejected: 3 }) });
      expect(result.breaches.map((b) => b.guard)).toEqual(["sourceEmpty"]);
    });

    it("passes when sync read videos, when no sync ran, or when the week before the cursor held none", async () => {
      seedAll();
      const newestNative = Math.max(...native.map((e) => e.created_at));
      state.setCursor("videos", newestNative);
      expect((await run({ runId: "r1", sync: sync({ same: 1 }) })).breaches).toEqual([]);
      expect((await run({ runId: "r2" })).breaches).toEqual([]);
      state.setCursor("videos", newestNative + 30 * 86_400);
      expect((await run({ runId: "r3", sync: sync() })).breaches).toEqual([]);
    });
  });
});
