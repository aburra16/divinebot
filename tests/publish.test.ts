import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publish } from "../src/commands/publish.js";
import { loadConfig, type Config } from "../src/config.js";
import { contentHash } from "../src/diff.js";
import { openState, type State } from "../src/state.js";
import { writeManifest } from "./run-manifest.js";
import { startStubRelay, type StubContext, type StubRelay } from "./stub-relay.js";

// Every relay here is a stub on loopback or the refused port 9: nothing leaves this machine.
const REFUSED = "ws://127.0.0.1:9";

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const COORD = loadConfig("config.json").headerCoordinate;
const T = 1_700_000_000;
/** The author of the source videos the items are built from. */
const VIDEO_AUTHOR = "e".repeat(64);
const sourceTag = (d: string): string[] => ["a", `34236:${VIDEO_AUTHOR}:${d}`];
const sourceAddress = (d: string): string => `${VIDEO_AUTHOR}:${d}`;

let dir: string;
let runDir: string;
let state: State;
let stubs: StubRelay[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divinebot-publish-"));
  runDir = join(dir, "out", "run1");
  mkdirSync(runDir, { recursive: true });
  state = openState(":memory:");
  stubs = [];
});

afterEach(async () => {
  state.close();
  for (const stub of stubs) await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function stub(onEvent: (ev: NostrEvent, ctx: StubContext) => void): Promise<StubRelay> {
  const s = await startStubRelay(onEvent);
  stubs.push(s);
  return s;
}

const acceptAll = (_: NostrEvent, ctx: StubContext) => ctx.reply(true, "");

/** A config for `relays`, with the manifest.json build would write for it in run1 and run2. */
function config(relays: Record<string, string>, publishCfg: Partial<Config["publish"]> = {}): Config {
  const cfg: Config = {
    ...loadConfig("config.json"),
    curatorPubkey: pubkey,
    relays,
    headerRelay: Object.keys(relays)[0]!,
    publish: { eventsPerSecond: 1000, okTimeoutMs: 2_000, ...publishCfg },
    paths: { out: join(dir, "out"), state: ":memory:" },
  };
  for (const run of ["run1", "run2"]) writeManifest(join(dir, "out", run), cfg);
  return cfg;
}

function item(d: string, key = secret, over: Partial<Parameters<typeof finalizeEvent>[0]> = {}): NostrEvent {
  return finalizeEvent(
    { kind: 39999, created_at: T, content: "", tags: [["d", d], ["z", COORD], sourceTag(d), ["name", `Place ${d}`]], ...over },
    key,
  );
}

function deletion(d: string, ids: string[]): NostrEvent {
  return finalizeEvent(
    {
      kind: 5,
      created_at: T + 1,
      content: "",
      tags: [...ids.map((id) => ["e", id]), ["a", `39999:${pubkey}:${d}`], ["k", "39999"]],
    },
    secret,
  );
}

function writeSigned(lines: unknown[], dir = runDir): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "signed.jsonl"),
    lines.map((l) => `${typeof l === "string" ? l : JSON.stringify(l)}\n`).join(""),
  );
}

describe("publish", () => {
  it("rejected events are recorded as failed and not marked live", async () => {
    const relay = await stub((_, ctx) => ctx.reply(false, "blocked: test"));
    const events = [item("osm-node-1"), item("osm-node-2")];
    writeSigned(events);
    const recordResult = vi.spyOn(state, "recordResult");
    const markLive = vi.spyOn(state, "markLive");

    const result = await publish(config({ dcosl: relay.url }), state, runDir);

    expect(result).toEqual({ dcosl: { sent: 2, ok: 0, failed: 2, skipped: 0 } });
    for (const ev of events) {
      expect(recordResult).toHaveBeenCalledWith({
        eventId: ev.id,
        d: ev.tags[0]![1],
        kind: 39999,
        createdAt: T,
        runId: "run1",
        relay: "dcosl",
        ok: false,
        message: "blocked: test",
      });
      expect(state.acceptedOn(ev.id, "dcosl")).toBe(false);
    }
    expect(markLive).not.toHaveBeenCalled();
    expect(state.liveItems().size).toBe(0);
    expect(state.runs()).toEqual([{ runId: "run1", relay: "dcosl", ok: 0, failed: 2 }]);
  });

  it("records the source address from the item's a tag, and a deletion touches no address", async () => {
    const relay = await stub(acceptAll);
    const first = item("divine-aa-vid:1");
    const second = item("divine-bb-vid-2");
    const gone = deletion("divine-cc-vid-3", ["a".repeat(64)]);
    state.markLive("divine-cc-vid-3", "h", "[]", "a".repeat(64), 1, sourceAddress("divine-cc-vid-3"));
    writeSigned([first, second, gone]);
    const markLive = vi.spyOn(state, "markLive");

    await publish(config({ dcosl: relay.url }), state, runDir);

    expect(markLive).toHaveBeenCalledTimes(2);
    const live = state.liveItems();
    expect(live.get("divine-aa-vid:1")!.address).toBe(first.tags.find((t) => t[0] === "a")![1]!.slice("34236:".length));
    expect(live.get("divine-aa-vid:1")!.address).toBe(sourceAddress("divine-aa-vid:1"));
    expect(live.get("divine-bb-vid-2")!.address).toBe(sourceAddress("divine-bb-vid-2"));
    expect(live.has("divine-cc-vid-3")).toBe(false);
  });

  it("marks an item live on its first OK only, and a deletion's item deleted", async () => {
    const [a, b] = [await stub(acceptAll), await stub(acceptAll)];
    const first = item("osm-node-1");
    const gone = deletion("osm-node-7", ["a".repeat(64)]);
    state.markLive("osm-node-7", "h", "[]", "a".repeat(64), 1, sourceAddress("osm-node-7"));
    writeSigned([first, gone]);
    const markLive = vi.spyOn(state, "markLive");
    const markDeleted = vi.spyOn(state, "markDeleted");

    const result = await publish(config({ dcosl: a.url, search: b.url }), state, runDir);

    expect(result.dcosl).toEqual({ sent: 2, ok: 2, failed: 0, skipped: 0 });
    expect(result.search).toEqual({ sent: 2, ok: 2, failed: 0, skipped: 0 });
    expect(markLive).toHaveBeenCalledTimes(1);
    expect(markLive).toHaveBeenCalledWith(
      "osm-node-1",
      contentHash(first.tags),
      JSON.stringify(first.tags),
      first.id,
      T,
      sourceAddress("osm-node-1"),
    );
    expect(markDeleted).toHaveBeenCalledTimes(1);
    expect(markDeleted).toHaveBeenCalledWith("osm-node-7", T + 1);
    expect([...state.liveItems().keys()]).toEqual(["osm-node-1"]);
    // A deletion is recorded under its item's d, and is not a version of it.
    expect(state.versionsOf("osm-node-7")).toEqual([]);
    expect(state.acceptedOn(gone.id, "dcosl")).toBe(true);
  });

  it("does not mark an item live again when a later run sends it to another relay", async () => {
    const [a, b] = [await stub(acceptAll), await stub(acceptAll)];
    const ev = item("osm-node-1");
    writeSigned([ev]);
    await publish(config({ dcosl: a.url, search: b.url }), state, runDir, ["dcosl"]);
    const markLive = vi.spyOn(state, "markLive");

    const result = await publish(config({ dcosl: a.url, search: b.url }), state, runDir, ["search"]);

    expect(result).toEqual({ search: { sent: 1, ok: 1, failed: 0, skipped: 0 } });
    expect(markLive).not.toHaveBeenCalled();
  });

  describe("never moves state back to an older event", () => {
    const run2 = () => join(dir, "out", "run2");
    const at = (created_at: number, name: string) =>
      item("osm-node-1", secret, { created_at, tags: [["d", "osm-node-1"], ["z", COORD], sourceTag("osm-node-1"), ["name", name]] });

    it("an older run published after a newer one is recorded but not made live", async () => {
      const relay = await stub(acceptAll);
      const cfg = config({ dcosl: relay.url });
      const older = at(T, "Old name");
      const newer = at(T + 100, "New name");
      writeSigned([newer], run2());
      writeSigned([older]);
      await publish(cfg, state, run2());

      const result = await publish(cfg, state, runDir);

      expect(result).toEqual({ dcosl: { sent: 1, ok: 1, failed: 0, skipped: 0 } });
      expect(state.acceptedOn(older.id, "dcosl")).toBe(true);
      expect(state.versionsOf("osm-node-1")).toEqual([older.id, newer.id]);
      expect(state.liveItems().get("osm-node-1")).toEqual({
        d: "osm-node-1",
        contentHash: contentHash(newer.tags),
        tagsJson: JSON.stringify(newer.tags),
        latestEventId: newer.id,
        address: sourceAddress("osm-node-1"),
      });
    });

    it("an older item does not bring back an item deleted after it", async () => {
      const relay = await stub(acceptAll);
      const cfg = config({ dcosl: relay.url });
      const older = at(T, "Old name");
      writeSigned([deletion("osm-node-1", ["a".repeat(64)])], run2()); // created_at T + 1
      writeSigned([older]);
      state.markLive("osm-node-1", "h", "[]", "a".repeat(64), T - 10, sourceAddress("osm-node-1"));
      await publish(cfg, state, run2());
      expect(state.liveItems().has("osm-node-1")).toBe(false);

      await publish(cfg, state, runDir);

      expect(state.liveItems().has("osm-node-1")).toBe(false);
    });

    it("an older deletion does not delete a newer live version", async () => {
      const relay = await stub(acceptAll);
      const cfg = config({ dcosl: relay.url });
      const newer = at(T + 100, "New name");
      writeSigned([newer], run2());
      writeSigned([deletion("osm-node-1", ["a".repeat(64)])]); // created_at T + 1
      await publish(cfg, state, run2());

      await publish(cfg, state, runDir);

      expect(state.liveItems().get("osm-node-1")?.latestEventId).toBe(newer.id);
    });
  });

  it("records each pair as pending before sending it", async () => {
    const log: string[] = [];
    let versionsWhenReceived: string[] = [];
    const ev = item("osm-node-1");
    // The relay takes the event and never answers. Were the process to die now, the version
    // must already be in state, or a later deletion would leave it out.
    const relay = await stub(() => {
      log.push("received");
      versionsWhenReceived = state.versionsOf("osm-node-1");
    });
    writeSigned([ev]);
    const record = state.recordResult.bind(state);
    vi.spyOn(state, "recordResult").mockImplementation((r) => {
      log.push(`recorded ${r.ok ? "ok" : "failed"}: ${r.message}`);
      record(r);
    });

    const result = await publish(config({ dcosl: relay.url }, { okTimeoutMs: 300 }), state, runDir);

    expect(result).toEqual({ dcosl: { sent: 1, ok: 0, failed: 1, skipped: 0 } });
    expect(log).toEqual(["recorded failed: pending", "received", "recorded failed: publish timed out"]);
    expect(versionsWhenReceived).toEqual([ev.id]);
    expect(state.acceptedOn(ev.id, "dcosl")).toBe(false);
  });

  it("waits and retries once on a rate-limited reply", async () => {
    const relay = await stub((_, ctx) =>
      ctx.n === 1 ? ctx.reply(false, "rate-limited: slow down") : ctx.reply(true, ""),
    );
    const ev = item("osm-node-1");
    writeSigned([ev]);
    const started = Date.now();

    const result = await publish(config({ dcosl: relay.url }), state, runDir, undefined, { backoffMs: 150 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(result).toEqual({ dcosl: { sent: 1, ok: 1, failed: 0, skipped: 0 } });
    expect(relay.received.map((e) => e.id)).toEqual([ev.id, ev.id]);
    expect(state.acceptedOn(ev.id, "dcosl")).toBe(true);
    expect(state.liveItems().has("osm-node-1")).toBe(true);
  });

  it("gives up after one retry when the relay stays rate-limited", async () => {
    const relay = await stub((_, ctx) => ctx.reply(false, "rate-limited: still too fast"));
    writeSigned([item("osm-node-1")]);
    const recordResult = vi.spyOn(state, "recordResult");

    const result = await publish(config({ dcosl: relay.url }), state, runDir, undefined, { backoffMs: 10 });

    expect(result).toEqual({ dcosl: { sent: 1, ok: 0, failed: 1, skipped: 0 } });
    expect(relay.received).toHaveLength(2);
    expect(recordResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, message: "rate-limited: still too fast" }),
    );
  });

  it("throttles each relay to eventsPerSecond and keeps file order, items before deletions", async () => {
    const relay = await stub(acceptAll);
    const items = ["osm-node-1", "osm-node-2", "osm-node-3", "osm-node-4", "osm-node-5"].map((d) => item(d));
    const events = [...items, deletion("osm-node-9", ["b".repeat(64)])];
    writeSigned(events);
    const started = Date.now();

    await publish(config({ dcosl: relay.url }, { eventsPerSecond: 20 }), state, runDir);

    // Six sends at 20 per second are at least five 50 ms gaps apart.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(relay.received.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it("publishes to the relays concurrently", async () => {
    const slow = (_: NostrEvent, ctx: StubContext) => setTimeout(() => ctx.reply(true, ""), 150);
    const [a, b] = [await stub(slow), await stub(slow)];
    writeSigned(["osm-node-1", "osm-node-2", "osm-node-3", "osm-node-4"].map((d) => item(d)));
    const started = Date.now();

    await publish(config({ dcosl: a.url, search: b.url }), state, runDir);

    // One after the other would take 8 x 150 ms; side by side about 4 x 150 ms.
    expect(Date.now() - started).toBeLessThan(1_100);
    expect(a.received).toHaveLength(4);
    expect(b.received).toHaveLength(4);
  });

  it("calls onEventSent with a running count after each result", async () => {
    const [a, b] = [await stub(acceptAll), await stub(acceptAll)];
    writeSigned([item("osm-node-1"), item("osm-node-2")]);
    const counts: number[] = [];

    await publish(config({ dcosl: a.url, search: b.url }), state, runDir, undefined, {
      onEventSent: (n) => counts.push(n),
    });

    expect(counts).toEqual([1, 2, 3, 4]);
  });

  describe("progress", () => {
    it("reports every progressEvery results per relay, as <relay>: <n>/<total>", async () => {
      const [a, b] = [await stub(acceptAll), await stub(acceptAll)];
      writeSigned(["osm-node-1", "osm-node-2", "osm-node-3", "osm-node-4", "osm-node-5"].map((d) => item(d)));
      const lines: string[] = [];

      await publish(config({ dcosl: a.url, search: b.url }), state, runDir, undefined, {
        progressEvery: 2,
        onProgress: (line) => lines.push(line),
      });

      expect(lines.filter((l) => l.startsWith("dcosl"))).toEqual(["dcosl: 2/5", "dcosl: 4/5"]);
      expect(lines.filter((l) => l.startsWith("search"))).toEqual(["search: 2/5", "search: 4/5"]);
    });

    it("counts only the events this call sends, not those a relay already accepted", async () => {
      const relay = await stub(acceptAll);
      const events = ["osm-node-1", "osm-node-2", "osm-node-3", "osm-node-4"].map((d) => item(d));
      writeSigned(events);
      state.recordResult({
        eventId: events[0]!.id, d: "osm-node-1", kind: 39999, createdAt: T, runId: "run1", relay: "dcosl", ok: true, message: "",
      });
      const lines: string[] = [];

      await publish(config({ dcosl: relay.url }), state, runDir, undefined, {
        progressEvery: 1,
        onProgress: (line) => lines.push(line),
      });

      expect(lines).toEqual(["dcosl: 1/3", "dcosl: 2/3", "dcosl: 3/3"]);
    });

    it("writes to stderr every 500 results by default", async () => {
      const relay = await stub(acceptAll);
      writeSigned(Array.from({ length: 501 }, (_, i) => item(`osm-node-${i}`)));
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await publish(config({ dcosl: relay.url }, { eventsPerSecond: 1_000_000 }), state, runDir);
        expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual(["dcosl: 500/501\n"]);
      } finally {
        stderr.mockRestore();
      }
    }, 20_000);
  });

  describe("a relay that stops answering", () => {
    it("is dropped after timeoutBreaker timeouts in a row, with an error, and the run stays resumable", async () => {
      let answer = false;
      const relay = await stub((_, ctx) => {
        if (answer) ctx.reply(true, "");
      });
      const events = ["osm-node-1", "osm-node-2", "osm-node-3", "osm-node-4", "osm-node-5", "osm-node-6"].map((d) => item(d));
      writeSigned(events);
      const cfg = config({ dcosl: relay.url }, { okTimeoutMs: 50 });

      const first = await publish(cfg, state, runDir, undefined, { timeoutBreaker: 3 });

      expect(first.dcosl).toMatchObject({ sent: 3, ok: 0, failed: 3, skipped: 0 });
      expect(first.dcosl!.error).toMatch(
        /^ws:\/\/127\.0\.0\.1:\d+\/? did not answer 3 events in a row within 0\.05 s each; gave up after 3 events$/,
      );
      expect(relay.received).toHaveLength(3);
      expect(state.runs()).toEqual([{ runId: "run1", relay: "dcosl", ok: 0, failed: 3 }]);
      expect(state.liveItems().size).toBe(0);

      answer = true;
      const second = await publish(cfg, state, runDir, undefined, { timeoutBreaker: 3 });

      expect(second.dcosl).toEqual({ sent: 6, ok: 6, failed: 0, skipped: 0 });
      expect(state.liveItems().size).toBe(6);
    });

    it("is kept while an answer breaks the run of timeouts", async () => {
      // Answers every third event, so never three timeouts in a row.
      const relay = await stub((_, ctx) => {
        if (ctx.n % 3 === 0) ctx.reply(true, "");
      });
      writeSigned(["osm-node-1", "osm-node-2", "osm-node-3", "osm-node-4", "osm-node-5", "osm-node-6"].map((d) => item(d)));

      const result = await publish(config({ dcosl: relay.url }, { okTimeoutMs: 50 }), state, runDir, undefined, {
        timeoutBreaker: 3,
      });

      expect(result.dcosl).toEqual({ sent: 6, ok: 2, failed: 4, skipped: 0 });
    });

    it("does not stop the other relays", async () => {
      const silent = await stub(() => {});
      const good = await stub(acceptAll);
      writeSigned(["osm-node-1", "osm-node-2", "osm-node-3"].map((d) => item(d)));

      const result = await publish(config({ dcosl: silent.url, search: good.url }, { okTimeoutMs: 50 }), state, runDir, undefined, {
        timeoutBreaker: 2,
      });

      expect(result.dcosl).toMatchObject({ sent: 2, failed: 2, error: expect.stringMatching(/did not answer 2 events in a row/) });
      expect(result.search).toEqual({ sent: 3, ok: 3, failed: 0, skipped: 0 });
    });

    it("gives up after 20 timeouts in a row by default", async () => {
      const relay = await stub(() => {});
      writeSigned(Array.from({ length: 21 }, (_, i) => item(`osm-node-${i}`)));

      const result = await publish(config({ dcosl: relay.url }, { okTimeoutMs: 20 }), state, runDir);

      expect(result.dcosl).toMatchObject({ sent: 20, failed: 20 });
      expect(result.dcosl!.error).toMatch(/did not answer 20 events in a row/);
      expect(relay.received).toHaveLength(20);
    }, 20_000);
  });

  it("reports a relay it cannot reach, records nothing for it, and still finishes the others", async () => {
    const relay = await stub(acceptAll);
    writeSigned([item("osm-node-1")]);

    const result = await publish(config({ dcosl: REFUSED, search: relay.url }), state, runDir);

    expect(result.dcosl).toEqual({
      sent: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      error: expect.stringMatching(/cannot connect to ws:\/\/127\.0\.0\.1:9/),
    });
    expect(result.search).toEqual({ sent: 1, ok: 1, failed: 0, skipped: 0 });
    expect(state.runs()).toEqual([{ runId: "run1", relay: "search", ok: 1, failed: 0 }]);
  });

  it("stops sending to a relay that drops the connection, and says so", async () => {
    const relay = await stub((_, ctx) => ctx.socket.terminate());
    writeSigned([item("osm-node-1"), item("osm-node-2"), item("osm-node-3")]);

    const result = await publish(config({ dcosl: relay.url }), state, runDir);

    expect(result.dcosl).toMatchObject({ sent: 1, ok: 0, failed: 1, skipped: 0 });
    expect(result.dcosl!.error).toMatch(/lost the connection to ws:\/\/127\.0\.0\.1:\d+\/? after 1 event/);
    expect(relay.received).toHaveLength(1);
    expect(state.runs()).toEqual([{ runId: "run1", relay: "dcosl", ok: 0, failed: 1 }]);
  });

  it("accepts a manifest that lists the same relays in another order", async () => {
    const [a, b] = [await stub(acceptAll), await stub(acceptAll)];
    writeSigned([item("osm-node-1")]);
    const cfg = config({ dcosl: a.url, search: b.url });
    writeManifest(runDir, cfg, { relays: { search: b.url, dcosl: a.url } });

    const result = await publish(cfg, state, runDir);

    expect(result.dcosl).toEqual({ sent: 1, ok: 1, failed: 0, skipped: 0 });
    expect(result.search).toEqual({ sent: 1, ok: 1, failed: 0, skipped: 0 });
  });

  it("does not connect to a relay that already accepted every event", async () => {
    const relay = await stub(acceptAll);
    writeSigned([item("osm-node-1")]);
    const cfg = config({ dcosl: relay.url });
    await publish(cfg, state, runDir);
    expect(relay.connections).toBe(1);

    const again = await publish(cfg, state, runDir);

    expect(again).toEqual({ dcosl: { sent: 0, ok: 0, failed: 0, skipped: 1 } });
    expect(relay.connections).toBe(1);
  });

  describe("refuses before sending anything", () => {
    const other = generateSecretKey();
    const good = () => item("osm-node-1");
    const cases: [string, () => unknown[], RegExp][] = [
      ["a broken signature", () => [good(), { ...item("osm-node-2"), sig: "0".repeat(128) }], /line 2: .*signature/],
      ["a tampered tag", () => [{ ...good(), tags: [["d", "osm-node-1"], ["name", "Other"]] }], /line 1: .*signature/],
      ["another author", () => [item("osm-node-1", other)], /line 1: signed by [0-9a-f]{64}, not the curator/],
      [
        "a kind it does not publish",
        () => [good(), item("osm-node-2"), finalizeEvent({ kind: 39998, created_at: T, content: "", tags: [["d", "x"]] }, secret)],
        /line 3: kind 39998/,
      ],
      ["a line that is not JSON", () => [good(), "{nope"], /line 2: not valid JSON/],
      ["a line that is not an event", () => [{ kind: 39999 }], /line 1: not a nostr event/],
      ["an item without a d tag", () => [finalizeEvent({ kind: 39999, created_at: T, content: "", tags: [["z", COORD]] }, secret)], /line 1: .*d tag/],
      [
        "an item for another list",
        () => [good(), item("osm-node-2", secret, { tags: [["d", "osm-node-2"], ["z", `39998:${"a".repeat(64)}:other-list`]] })],
        /line 2: .*z is 39998:a{64}:other-list, not the header 39998:/,
      ],
      [
        "an item with no a tag",
        () => [good(), item("osm-node-2", secret, { tags: [["d", "osm-node-2"], ["z", COORD], ["name", "x"]] })],
        /line 2: .*one a tag naming its source video/,
      ],
      [
        "an item whose a tag is not a 34236 coordinate",
        () => [item("osm-node-2", secret, { tags: [["d", "osm-node-2"], ["z", COORD], ["a", `30023:${VIDEO_AUTHOR}:x`]] })],
        /line 1: .*one a tag naming its source video/,
      ],
      [
        "an item whose 34236 a tag has a short pubkey",
        () => [item("osm-node-2", secret, { tags: [["d", "osm-node-2"], ["z", COORD], ["a", "34236:abc:x"]] })],
        /line 1: .*one a tag naming its source video/,
      ],
      [
        "an item whose 34236 a tag has an empty d",
        () => [item("osm-node-2", secret, { tags: [["d", "osm-node-2"], ["z", COORD], ["a", `34236:${VIDEO_AUTHOR}:`]] })],
        /line 1: .*one a tag naming its source video/,
      ],
      [
        "an item with two 34236 a tags",
        () => [
          item("osm-node-2", secret, {
            tags: [["d", "osm-node-2"], ["z", COORD], ["a", `34236:${VIDEO_AUTHOR}:x`], ["a", `34236:${VIDEO_AUTHOR}:y`]],
          }),
        ],
        /line 1: .*one a tag naming its source video/,
      ],
      ["an item without a z tag", () => [item("osm-node-2", secret, { tags: [["d", "osm-node-2"]] })], /line 1: .*exactly one z tag/],
      [
        "an item with two z tags",
        () => [item("osm-node-2", secret, { tags: [["d", "osm-node-2"], ["z", COORD], ["z", COORD]] })],
        /line 1: .*exactly one z tag/,
      ],
      [
        "a deletion without an a tag for the curator's item",
        () => [finalizeEvent({ kind: 5, created_at: T, content: "", tags: [["e", "c".repeat(64)], ["k", "39999"]] }, secret)],
        /line 1: .*a tag/,
      ],
      ["the same event twice", () => { const ev = good(); return [ev, ev]; }, /line 2: repeats line 1/],
      ["an item after a deletion", () => [deletion("osm-node-9", ["d".repeat(64)]), good()], /line 2: .*after a deletion/],
    ];

    for (const [name, lines, message] of cases) {
      it(name, async () => {
        const relay = await stub(acceptAll);
        writeSigned(lines());
        const recordResult = vi.spyOn(state, "recordResult");

        await expect(publish(config({ dcosl: relay.url }), state, runDir)).rejects.toThrow(message);

        expect(relay.connections).toBe(0);
        expect(recordResult).not.toHaveBeenCalled();
      });
    }

    it("an unknown relay name", async () => {
      const relay = await stub(acceptAll);
      writeSigned([good()]);
      await expect(publish(config({ dcosl: relay.url }), state, runDir, ["dcosl", "nope"])).rejects.toThrow(
        /unknown relay "nope"; the relays are dcosl/,
      );
      expect(relay.connections).toBe(0);
      expect(state.runs()).toEqual([]);
    });

    it("a run built for other relays, naming the field", async () => {
      const relay = await stub(acceptAll);
      writeSigned([good()]);
      const cfg = config({ dcosl: relay.url });
      writeManifest(runDir, cfg, { relays: { dcosl: relay.url, search: "ws://127.0.0.1:9" } });
      const recordResult = vi.spyOn(state, "recordResult");

      await expect(publish(cfg, state, runDir)).rejects.toThrow(
        /built with another config: relays is \{"dcosl":"ws:\/\/127\.0\.0\.1:\d+","search":"ws:\/\/127\.0\.0\.1:9"\} in .*manifest\.json/,
      );
      expect(relay.connections).toBe(0);
      expect(recordResult).not.toHaveBeenCalled();
    });

    it("a run with no manifest", async () => {
      const relay = await stub(acceptAll);
      writeSigned([good()]);
      const cfg = config({ dcosl: relay.url });
      rmSync(join(runDir, "manifest.json"));

      await expect(publish(cfg, state, runDir)).rejects.toThrow(/manifest\.json not found/);
      expect(relay.connections).toBe(0);
    });

    it("a run that is not signed yet", async () => {
      await expect(publish(config({ dcosl: REFUSED }), state, runDir)).rejects.toThrow(/npm run sign/);
    });

    it("an empty signed.jsonl", async () => {
      writeSigned([]);
      await expect(publish(config({ dcosl: REFUSED }), state, runDir)).rejects.toThrow(/no events/);
    });
  });
});
