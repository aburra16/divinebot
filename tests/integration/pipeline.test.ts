import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import * as nip19 from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "../../src/commands/build.js";
import { publish } from "../../src/commands/publish.js";
import { runPipeline, type PipelineDeps, type RunOutcome } from "../../src/commands/run.js";
import { sign } from "../../src/commands/sign.js";
import { verify, type RelayVerifyResult } from "../../src/commands/verify.js";
import { loadConfig, type Config } from "../../src/config.js";
import { tagValue } from "../../src/tags.js";
import { runMediaChecks } from "../../src/media.js";
import { refreshProfiles } from "../../src/profiles.js";
import { connectRelay, queryAll } from "../../src/relay.js";
import { unixNow } from "../../src/source/sync.js";
import { openState, type State } from "../../src/state.js";
import { startNak } from "./nak.js";
import { startStubDivine, type StubDivine } from "./stub-divine.js";

// Everything talks to loopback: `nak serve` stands in for the target relays, a stub for the
// Divine relay, and an injected fetch for media and NIP-05 (thumbnails must be https, and a
// local HTTPS server is not worth it). No public host is ever reached.
// Two instances, as in production: nak refuses a kind 5 whose events are already gone ("blocked:
// nothing to delete"), so two relay names on one nak cannot both accept a deletion.
const DCOSL_PORT = 10597;
const SEARCH_PORT = 10596;
const VIDEO_KIND = 34236;
const ITEM_KIND = 39999;
const DAY = 86_400;
const MEDIA = "https://media.divine.video";
/** Videos built per world. More than the deletion floor (25) plus the 10 that must stay live. */
const VIDEOS = 40;

let nak: { url: string; stop(): Promise<void> };
let searchNak: { url: string; stop(): Promise<void> };
const headerSecret = generateSecretKey();
const COORD = `39998:${getPublicKey(headerSecret)}:divine-videos`;
/** Source created_at values are in the past, so cursors (clamped to now) never skip them. */
const T0 = unixNow() - 200_000;
/** Each sign gets a later created_at than the one before, as wall-clock runs would. */
let clock = unixNow() - 50_000;
/** Each edit and deletion gets a later created_at than the one before, still before now. */
let sourceClock = unixNow() - 5_000;

beforeAll(async () => {
  nak = await startNak(DCOSL_PORT);
  searchNak = await startNak(SEARCH_PORT);
  const fixture = JSON.parse(readFileSync("tests/fixtures/live-header.json", "utf8")) as NostrEvent;
  const header = finalizeEvent(
    {
      kind: 39998,
      created_at: unixNow() - 100_000,
      content: "",
      tags: fixture.tags.map((t) => (t[0] === "b" ? ["b", COORD] : t)),
    },
    headerSecret,
  );
  for (const url of [nak.url, searchNak.url]) {
    const relay = await connectRelay(url, 5_000);
    try {
      await relay.publish(header);
    } finally {
      relay.close();
    }
  }
}, 20_000);

afterAll(async () => {
  await nak?.stop();
  await searchNak?.stop();
});

interface Creator {
  secret: Uint8Array;
  pubkey: string;
  nip05?: string;
}

interface Video {
  creator: Creator;
  sha: string;
  thumb: string;
  event: NostrEvent;
  /** The item `d` the bot builds from it. */
  itemD: string;
}

interface World {
  dir: string;
  cfg: Config;
  state: State;
  stub: StubDivine;
  keyPath: string;
  curatorPubkey: string;
  creators: Creator[];
  videos: Video[];
  /** Media answers by URL; anything not listed is a 200 with the right type. */
  mediaStatus: Map<string, number>;
  /** NIP-05 answers: `name@domain` to the pubkey it resolves to. */
  nip05: Map<string, string>;
  fetch: typeof fetch;
  logs: string[];
  warns: string[];
  runSeq: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function videoEvent(creator: Creator, i: number, opts: { title?: string; created_at?: number; extra?: string[][] } = {}): Video {
  const sha = sha256(`video-${i}`);
  const thumb = sha256(`thumb-${i}`);
  const created = opts.created_at ?? T0 + i * 10;
  const tags: string[][] = [
    ["d", sha],
    [
      "imeta",
      `url ${MEDIA}/${sha}`,
      "m video/mp4",
      `image ${MEDIA}/${thumb}`,
      `x ${sha}`,
      "dim 1080x1920",
      "size 1000000",
    ],
    ["title", opts.title ?? `Video ${i}`],
    ["summary", `Caption ${i}\n#fun`],
    ["t", "fun"],
    ["published_at", String(created - 60)],
    ["duration", "6"],
    ["client", "divinebot-test"],
    ["verification", "verified_mobile"],
    ...(opts.extra ?? []),
  ];
  const event = finalizeEvent({ kind: VIDEO_KIND, created_at: created, content: "", tags }, creator.secret);
  return { creator, sha, thumb, event, itemD: `divine-${creator.pubkey}-${sha}` };
}

function profileEvent(creator: Creator, name: string): NostrEvent {
  const content: Record<string, string> = { name: `${name}-handle`, display_name: name };
  if (creator.nip05 !== undefined) content.nip05 = creator.nip05;
  return finalizeEvent({ kind: 0, created_at: T0 - 500, content: JSON.stringify(content), tags: [] }, creator.secret);
}

function authorDeletion(video: Video): NostrEvent {
  return finalizeEvent(
    {
      kind: 5,
      created_at: ++sourceClock,
      content: "",
      tags: [["a", `${VIDEO_KIND}:${video.creator.pubkey}:${video.sha}`], ["k", String(VIDEO_KIND)]],
    },
    video.creator.secret,
  );
}

const worlds: World[] = [];

/**
 * A fresh curator key, state, out dir, Divine stub and set of creators. Each world signs with its
 * own curator key and the tests read nak by that author, so worlds sharing the one nak never see
 * each other. The stub holds `VIDEOS` eligible native videos from five creators, a classic Vine
 * and a video with a content warning (never built), and the creators' profiles.
 */
async function newWorld(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "divinebot-e2e-"));
  const curator = generateSecretKey();
  const curatorPubkey = getPublicKey(curator);
  const keyPath = join(dir, "curator.key");
  writeFileSync(keyPath, `${nip19.nsecEncode(curator)}\n`, { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  const creators: Creator[] = Array.from({ length: 5 }, () => {
    const secret = generateSecretKey();
    return { secret, pubkey: getPublicKey(secret) };
  });
  // Creator 0 has a Divine handle that resolves both ways, so the item carries `alice@divine.video`.
  creators[0]!.nip05 = "_@alice.divine.video";
  // Creator 1 claims a handle that does not resolve to them.
  creators[1]!.nip05 = "bob@example.com";
  const nip05 = new Map<string, string>([
    ["_@alice.divine.video", creators[0]!.pubkey],
    ["alice@divine.video", creators[0]!.pubkey],
    ["bob@example.com", getPublicKey(generateSecretKey())],
  ]);

  const videos = Array.from({ length: VIDEOS }, (_, i) => videoEvent(creators[i % creators.length]!, i));
  const vine = videoEvent(creators[2]!, 1000, { extra: [["l", "vine-archive"], ["platform", "vine"]] });
  const warned = videoEvent(creators[3]!, 1001, { extra: [["content-warning", "nsfw"]] });
  const profiles = creators.map((c, i) => profileEvent(c, `Creator ${i}`));
  const stub = await startStubDivine([...videos.map((v) => v.event), vine.event, warned.event, ...profiles]);

  const mediaStatus = new Map<string, number>();
  const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.startsWith(`${MEDIA}/`)) {
      const type = url.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
      return new Response(null, { status: mediaStatus.get(url) ?? 200, headers: { "content-type": type } });
    }
    const lookup = /^https:\/\/([^/]+)\/\.well-known\/nostr\.json\?name=(.+)$/.exec(url);
    if (lookup !== null) {
      const key = `${decodeURIComponent(lookup[2]!)}@${lookup[1]}`;
      const pubkey = nip05.get(key);
      return new Response(JSON.stringify({ names: pubkey === undefined ? {} : { [key.split("@")[0]!]: pubkey } }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch of ${url}: the test reaches no public host`);
  }) as typeof fetch;

  const base = loadConfig("config.json");
  const cfg: Config = {
    ...base,
    headerCoordinate: COORD,
    curatorPubkey,
    relays: { dcosl: nak.url, search: searchNak.url },
    headerRelay: "dcosl",
    // nak serve needs no search field.
    relayReadSearch: undefined,
    source: { ...base.source, relay: stub.url, pageSize: 20, pageDelayMs: 0, harvestSince: 0 },
    media: { ...base.media, requestsPerSecond: 1000 },
    publish: { eventsPerSecond: 1000, okTimeoutMs: 5_000 },
    paths: { out: join(dir, "out"), state: join(dir, "state", "state.sqlite") },
  };
  for (const url of [...Object.values(cfg.relays), cfg.source.relay]) {
    if (new URL(url).hostname !== "127.0.0.1") throw new Error(`test relay is not on loopback: ${url}`);
  }

  const w: World = {
    dir,
    cfg,
    state: openState(cfg.paths.state),
    stub,
    keyPath,
    curatorPubkey,
    creators,
    videos,
    mediaStatus,
    nip05,
    fetch: fakeFetch,
    logs: [],
    warns: [],
    runSeq: 0,
  };
  worlds.push(w);
  return w;
}

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    w.state.close();
    await w.stub.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

const noInfo = async (): Promise<unknown> => {
  throw new Error("no NIP-11 in tests");
};

/** The real steps, with the network, key, clock and run ids supplied by the world. */
function depsFor(w: World, extra: Partial<PipelineDeps> = {}): Partial<PipelineDeps> {
  return {
    log: (line) => w.logs.push(line),
    warn: (line) => w.warns.push(line),
    refreshProfiles: (c, s) => refreshProfiles(c, s, { fetch: w.fetch }),
    runMediaChecks: (c, s) => runMediaChecks(c, s, { fetch: w.fetch, sleep: async () => {} }),
    // Run ids are timestamps to the second; two runs in one second would collide.
    build: (c, s, o) => build(c, s, { ...o, runId: `run-${String(++w.runSeq).padStart(3, "0")}` }),
    sign: (c, dir, o) => sign(c, dir, { ...o, keyPath: w.keyPath, now: () => ++clock }),
    verify: (c, s) => verify(c, s, { fetchRelayInfo: noInfo }),
    ...extra,
  };
}

const run = (w: World, extra: Partial<PipelineDeps> = {}): Promise<RunOutcome> =>
  runPipeline(w.cfg, w.state, { auto: true, deps: depsFor(w, extra) });

/** The items nak holds for this world's curator, by `d`; both relays must hold the same events. */
async function itemsOnNak(w: World): Promise<Map<string, NostrEvent>> {
  const [dcosl, search] = await Promise.all(
    [nak.url, searchNak.url].map((url) => queryAll(url, { kinds: [ITEM_KIND], authors: [w.curatorPubkey] })),
  );
  expect(search!.map((e) => e.id).sort()).toEqual(dcosl!.map((e) => e.id).sort());
  return new Map(dcosl!.map((e) => [tagValue(e.tags, "d")!, e]));
}

/** Kind 5 events the curator has on either relay. */
async function deletionsOnNak(w: World): Promise<NostrEvent[]> {
  const found = await Promise.all(
    [nak.url, searchNak.url].map((url) => queryAll(url, { kinds: [5], authors: [w.curatorPubkey] })),
  );
  return found.flat();
}

function expectClean(result: Record<string, RelayVerifyResult>, items: number): void {
  expect(Object.keys(result).sort()).toEqual(["dcosl", "search"]);
  for (const r of Object.values(result)) {
    expect(r).toMatchObject({ onRelay: items, inState: items, missing: [], extra: [], stale: [], extraCheck: "complete" });
  }
}

/** Scenario (a)'s flow, shared: a first run for a person, then sign and publish by hand. */
async function firstImport(w: World): Promise<RunOutcome> {
  const outcome = await runPipeline(w.cfg, w.state, { auto: false, firstRun: true, deps: depsFor(w) });
  expect(outcome.exitCode).toBe(0);
  const deps = depsFor(w);
  await deps.sign!(w.cfg, outcome.runDir!, {});
  const results = await publish(w.cfg, w.state, outcome.runDir!);
  for (const r of Object.values(results)) expect(r).toMatchObject({ sent: VIDEOS, ok: VIDEOS, failed: 0 });
  return outcome;
}

describe("pipeline against nak serve", () => {
  it("(a) first run, then sign and publish by hand: one item per eligible video, nothing missing", async () => {
    const w = await newWorld();
    const outcome = await runPipeline(w.cfg, w.state, { auto: false, firstRun: true, deps: depsFor(w) });
    expect(outcome).toMatchObject({ stoppedForReview: false, breaches: [], exitCode: 0 });
    expect(w.logs.join("\n")).toContain(`created ${VIDEOS}, changed 0, unchanged 0, deletions 0`);
    // The video with a content warning is skipped, and says why. The classic Vine is out of scope.
    expect(w.logs.join("\n")).toContain("skipped: content-warning 1");
    // A manual run builds and stops: nothing is on nak yet.
    expect((await itemsOnNak(w)).size).toBe(0);

    const signed = await depsFor(w).sign!(w.cfg, outcome.runDir!, {});
    expect(signed.signed).toBe(VIDEOS);
    const published = await publish(w.cfg, w.state, outcome.runDir!);
    expect(published).toEqual({
      dcosl: { sent: VIDEOS, ok: VIDEOS, failed: 0, skipped: 0 },
      search: { sent: VIDEOS, ok: VIDEOS, failed: 0, skipped: 0 },
    });

    const onNak = await itemsOnNak(w);
    expect([...onNak.keys()].sort()).toEqual(w.videos.map((v) => v.itemD).sort());
    const first = onNak.get(w.videos[0]!.itemD)!;
    expect(tagValue(first.tags, "title")).toBe("Video 0");
    expect(tagValue(first.tags, "z")).toBe(COORD);
    expect(tagValue(first.tags, "creator")).toBe("Creator 0");
    // Verified handle in its root form; the unverified claim of creator 1 is left out.
    expect(tagValue(first.tags, "creator-nip05")).toBe("alice@divine.video");
    expect(tagValue(onNak.get(w.videos[1]!.itemD)!.tags, "creator-nip05")).toBeUndefined();

    expectClean(await verify(w.cfg, w.state, { fetchRelayInfo: noInfo }), VIDEOS);
    // The source stub was read in pages of 20.
    expect(w.stub.requests.some((f) => f.limit === 20)).toBe(true);
  });

  it("(b) an edited video republishes one item", async () => {
    const w = await newWorld();
    await firstImport(w);
    const before = (await itemsOnNak(w)).get(w.videos[3]!.itemD)!;

    const edited = videoEvent(w.videos[3]!.creator, 3, { title: "Video 3 edited", created_at: ++sourceClock });
    w.stub.add(edited.event);
    const outcome = await run(w);

    expect(outcome).toMatchObject({ stoppedForReview: false, exitCode: 0 });
    expect(w.logs.join("\n")).toContain(`created 0, changed 1, unchanged ${VIDEOS - 1}, deletions 0`);
    const onNak = await itemsOnNak(w);
    expect(onNak.size).toBe(VIDEOS);
    const after = onNak.get(w.videos[3]!.itemD)!;
    expect(tagValue(after.tags, "title")).toBe("Video 3 edited");
    expect(after.id).not.toBe(before.id);
    // Every other item is the event published before.
    for (const v of w.videos.filter((_, i) => i !== 3)) expect(onNak.has(v.itemD)).toBe(true);
    expect(w.state.versionsOf(w.videos[3]!.itemD)).toHaveLength(2);
    expectClean(await verify(w.cfg, w.state, { fetchRelayInfo: noInfo }), VIDEOS);
  });

  it("(c) a kind 5 from the video's author deletes its item on nak", async () => {
    const w = await newWorld();
    await firstImport(w);
    const gone = w.videos[5]!;
    w.stub.add(authorDeletion(gone));

    const outcome = await run(w);

    expect(outcome).toMatchObject({ stoppedForReview: false, exitCode: 0 });
    expect(w.logs.join("\n")).toContain("deletions applied 1, ignored 0");
    expect(w.logs.join("\n")).toContain(`deletions 1`);
    const onNak = await itemsOnNak(w);
    expect(onNak.size).toBe(VIDEOS - 1);
    expect(onNak.has(gone.itemD)).toBe(false);
    expect(w.state.liveItems().has(gone.itemD)).toBe(false);
    expect(w.state.deletedItems()).toEqual([gone.itemD]);
    expectClean(await verify(w.cfg, w.state, { fetchRelayInfo: noInfo }), VIDEOS - 1);
  });

  it("(d) a kind 5 from another key changes nothing", async () => {
    const w = await newWorld();
    await firstImport(w);
    const target = w.videos[7]!;
    const stranger = generateSecretKey();
    // Names the video both by its address and by its event id, which only the author may do.
    const hostile = finalizeEvent(
      {
        kind: 5,
        created_at: ++sourceClock,
        content: "",
        tags: [
          ["a", `${VIDEO_KIND}:${target.creator.pubkey}:${target.sha}`],
          ["e", target.event.id],
          ["a", `${VIDEO_KIND}:${getPublicKey(stranger)}:${target.sha}`],
          ["k", String(VIDEO_KIND)],
        ],
      },
      stranger,
    );
    w.stub.add(hostile);

    const outcome = await run(w);

    expect(outcome).toMatchObject({ stoppedForReview: false, exitCode: 0 });
    expect(w.logs.join("\n")).toContain("deletions applied 0, ignored 1");
    expect(w.logs.join("\n")).toContain("nothing to publish");
    expect((await itemsOnNak(w)).size).toBe(VIDEOS);
    expect(w.state.liveItems().size).toBe(VIDEOS);
    expect(w.state.source(`${target.creator.pubkey}:${target.sha}`)!.status).toBe("active");
    expect(await deletionsOnNak(w)).toEqual([]);
  });

  it("(e) a video gone from the source, found by a forced sweep, has its item deleted", async () => {
    const w = await newWorld();
    await firstImport(w);
    const gone = w.videos[11]!;
    w.stub.remove(gone.event.id);
    w.state.setCursor("last_sweep", unixNow() - 8 * DAY);

    const outcome = await run(w);

    expect(outcome).toMatchObject({ stoppedForReview: false, exitCode: 0 });
    expect(w.logs.join("\n")).toContain(`sweep: saw ${VIDEOS + 1} videos, 1 video vanished`);
    const onNak = await itemsOnNak(w);
    expect(onNak.size).toBe(VIDEOS - 1);
    expect(onNak.has(gone.itemD)).toBe(false);
    expect(w.state.source(`${gone.creator.pubkey}:${gone.sha}`)!.status).toBe("vanished");
    expect(w.state.deletedItems()).toEqual([gone.itemD]);
    expectClean(await verify(w.cfg, w.state, { fetchRelayInfo: noInfo }), VIDEOS - 1);
  });

  it("(f) a media 404 found on recheck deletes the item", async () => {
    const w = await newWorld();
    await firstImport(w);
    const bad = w.videos[13]!;
    const videoUrl = `${MEDIA}/${bad.sha}.mp4`;
    w.mediaStatus.set(videoUrl, 404);
    // Make this video's media rows the oldest, so the rolling recheck picks them up.
    w.state.putMedia(videoUrl, "pass", 200, "video/mp4", 1);
    w.state.putMedia(`${MEDIA}/${bad.thumb}`, "pass", 200, "image/jpeg", 1);

    const outcome = await run(w);

    expect(outcome).toMatchObject({ stoppedForReview: false, exitCode: 0 });
    expect(w.state.media(videoUrl)).toMatchObject({ status: "fail", httpStatus: 404 });
    const onNak = await itemsOnNak(w);
    expect(onNak.size).toBe(VIDEOS - 1);
    expect(onNak.has(bad.itemD)).toBe(false);
    expect(w.state.deletedItems()).toEqual([bad.itemD]);
    expectClean(await verify(w.cfg, w.state, { fetchRelayInfo: noInfo }), VIDEOS - 1);
  });

  it("(g) 30 author deletions at once stop an auto run for review: exit 2, NEEDS_REVIEW, nothing sent", async () => {
    const w = await newWorld();
    await firstImport(w);
    for (const v of w.videos.slice(0, 30)) w.stub.add(authorDeletion(v));

    const outcome = await run(w);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stoppedForReview).toBe(true);
    expect(outcome.breaches.map((b) => b.guard)).toEqual(["maxDeletions"]);
    expect(outcome.breaches[0]).toMatchObject({ limit: 25, actual: 30 });
    const marker = join(outcome.runDir!, "NEEDS_REVIEW");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toContain("deletes 30 items");
    expect(w.warns.join("\n")).toContain("stopped for review");
    // Built but never signed, and nothing deleted anywhere.
    expect(existsSync(join(outcome.runDir!, "unsigned.jsonl"))).toBe(true);
    expect(existsSync(join(outcome.runDir!, "signed.jsonl"))).toBe(false);
    expect((await itemsOnNak(w)).size).toBe(VIDEOS);
    expect(await deletionsOnNak(w)).toEqual([]);
    expect(w.state.liveItems().size).toBe(VIDEOS);

    // The next unattended run will not pile a second unfinished run on top of this one.
    const again = await run(w);
    expect(again).toMatchObject({ runDir: null, stoppedForReview: true, exitCode: 2 });
    expect(w.warns.join("\n")).toMatch(/earlier run run-002 is not fully published/);
  });

  it("(h) a publish killed after 3 events resumes: the rerun sends the rest without resending", async () => {
    const w = await newWorld();
    await firstImport(w);
    const edited = [0, 1, 2, 3, 4, 5].map((i) => videoEvent(w.videos[i]!.creator, i, { title: `Video ${i} v2`, created_at: ++sourceClock }));
    for (const e of edited) w.stub.add(e.event);
    const crash = (cfg: Config, state: State, dir: string, names?: string[]) =>
      publish(cfg, state, dir, names, {
        onEventSent: (n) => {
          if (n >= 3) throw new Error("simulated crash");
        },
      });

    await expect(run(w, { publish: crash })).rejects.toThrow("simulated crash");

    const runId = "run-002";
    const runDir = join(w.cfg.paths.out, runId);
    const pairs = 6 * Object.keys(w.cfg.relays).length;
    const acceptedBefore = w.state.runs().filter((r) => r.runId === runId).reduce((sum, r) => sum + r.ok, 0);
    expect(acceptedBefore).toBeGreaterThanOrEqual(3);
    expect(acceptedBefore).toBeLessThan(pairs);

    // An unattended run will not build on top of the unfinished one, and names the remedy.
    const blocked = await run(w);
    expect(blocked).toMatchObject({ runDir: null, stoppedForReview: true, exitCode: 2 });
    expect(w.warns.join("\n")).toContain(`npm run publish -- ${runId} --relays`);

    const resumed = await publish(w.cfg, w.state, runDir);
    const total = (key: "sent" | "ok" | "failed" | "skipped") => Object.values(resumed).reduce((sum, r) => sum + r[key], 0);
    expect(total("skipped")).toBe(acceptedBefore);
    expect(total("sent")).toBe(pairs - acceptedBefore);
    expect(total("ok")).toBe(pairs - acceptedBefore);
    expect(total("failed")).toBe(0);

    // Every event was accepted exactly once on each relay, and a third publish finds nothing to send.
    const accepted = w.state.runs().filter((r) => r.runId === runId).reduce((sum, r) => sum + r.ok, 0);
    expect(accepted).toBe(pairs);
    const third = await publish(w.cfg, w.state, runDir);
    expect(Object.values(third).reduce((sum, r) => sum + r.sent, 0)).toBe(0);

    const onNak = await itemsOnNak(w);
    expect(onNak.size).toBe(VIDEOS);
    for (const [i, e] of edited.entries()) {
      expect(tagValue(onNak.get(w.videos[i]!.itemD)!.tags, "title")).toBe(`Video ${i} v2`);
      expect(e.itemD).toBe(w.videos[i]!.itemD);
    }
    expectClean(await verify(w.cfg, w.state, { fetchRelayInfo: noInfo }), VIDEOS);

    // And the pipeline carries on: the next unattended run has nothing to do.
    const next = await run(w);
    expect(next).toMatchObject({ stoppedForReview: false, exitCode: 0 });
    expect(w.logs.join("\n")).toContain("nothing to publish");
  });
});
