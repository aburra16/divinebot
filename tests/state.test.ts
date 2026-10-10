import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools/core";
import { diffItems } from "../src/diff.js";
import { openState, type State } from "../src/state.js";

const DCOSL = "wss://dcosl.brainstorm.world";
const SEARCH = "wss://search.brainstorm.world";

let state: State;

beforeEach(() => {
  state = openState(":memory:");
});

afterEach(() => {
  state.close();
});

/** A recordResult argument with sensible defaults, so each test names only what it cares about. */
function result(over: Partial<Parameters<State["recordResult"]>[0]> = {}) {
  return {
    eventId: "e1",
    d: "divine-n1",
    kind: 39999,
    createdAt: 1000,
    runId: "run-1",
    relay: DCOSL,
    ok: true,
    message: "",
    ...over,
  };
}

describe("items", () => {
  it("markLive then liveItems returns it", () => {
    state.markLive("divine-n1", "hash-a", '[["d","divine-n1"]]', "e1", 100, "pk:divine-n1");

    expect(state.liveItems()).toEqual(
      new Map([
        [
          "divine-n1",
          {
            d: "divine-n1",
            contentHash: "hash-a",
            tagsJson: '[["d","divine-n1"]]',
            latestEventId: "e1",
            address: "pk:divine-n1",
          },
        ],
      ]),
    );
  });

  it("starts with no live items", () => {
    expect(state.liveItems().size).toBe(0);
  });

  it("markLive again replaces hash and latestEventId, while versionsOf keeps both ids", () => {
    state.recordResult(result({ eventId: "e1", createdAt: 1000 }));
    state.markLive("divine-n1", "hash-a", "[1]", "e1", 100, "pk:divine-n1");
    state.recordResult(result({ eventId: "e2", createdAt: 2000 }));
    state.markLive("divine-n1", "hash-b", "[2]", "e2", 200, "pk:divine-n1");

    const live = state.liveItems();
    expect(live.size).toBe(1);
    expect(live.get("divine-n1")).toEqual({
      d: "divine-n1",
      contentHash: "hash-b",
      tagsJson: "[2]",
      latestEventId: "e2",
      address: "pk:divine-n1",
    });
    expect(state.versionsOf("divine-n1")).toEqual(["e1", "e2"]);
  });

  it("markDeleted removes from liveItems, and versionsOf is unchanged", () => {
    state.recordResult(result({ eventId: "e1" }));
    state.markLive("divine-n1", "hash-a", "[1]", "e1", 100, "pk:divine-n1");
    state.markLive("divine-n2", "hash-b", "[2]", "e9", 100, "pk:divine-n2");

    state.markDeleted("divine-n1", 300);

    expect([...state.liveItems().keys()]).toEqual(["divine-n2"]);
    expect(state.versionsOf("divine-n1")).toEqual(["e1"]);
  });

  it("markLive after markDeleted brings the item back", () => {
    state.markLive("divine-n1", "hash-a", "[1]", "e1", 100, "pk:divine-n1");
    state.markDeleted("divine-n1", 200);
    state.markLive("divine-n1", "hash-c", "[3]", "e3", 300, "pk:divine-n1");

    expect(state.liveItems().get("divine-n1")?.latestEventId).toBe("e3");
  });

  it("lastChanged is the time of the latest markLive or markDeleted, live or not", () => {
    expect(state.lastChanged("divine-n1")).toBeUndefined();
    state.markLive("divine-n1", "hash-a", "[]", "e1", 100, "pk:divine-n1");
    expect(state.lastChanged("divine-n1")).toBe(100);
    state.markDeleted("divine-n1", 150);
    expect(state.lastChanged("divine-n1")).toBe(150);
  });

  it("markDeleted on an unknown d does nothing", () => {
    state.markDeleted("divine-n404", 100);

    expect(state.liveItems().size).toBe(0);
  });

  it("deletedItems lists the d of every deleted item, sorted, and changes nothing", () => {
    expect(state.deletedItems()).toEqual([]);
    state.markLive("divine-n3", "hash-c", "[3]", "e3", 100, "pk:divine-n3");
    state.markLive("divine-n1", "hash-a", "[1]", "e1", 100, "pk:divine-n1");
    state.markLive("divine-n2", "hash-b", "[2]", "e2", 100, "pk:divine-n2");
    state.markDeleted("divine-n3", 200);
    state.markDeleted("divine-n1", 200);
    expect(state.deletedItems()).toEqual(["divine-n1", "divine-n3"]);
    expect(state.deletedItems()).toEqual(["divine-n1", "divine-n3"]);
    expect(state.counts()).toEqual({ live: 1, deleted: 2 });

    state.markLive("divine-n3", "hash-d", "[4]", "e4", 300, "pk:divine-n3"); // revived
    expect(state.deletedItems()).toEqual(["divine-n1"]);
  });

  it("counts items by status, and a revived item counts as live again", () => {
    expect(state.counts()).toEqual({ live: 0, deleted: 0 });
    state.markLive("divine-n1", "hash-a", "[1]", "e1", 100, "pk:divine-n1");
    state.markLive("divine-n2", "hash-b", "[2]", "e2", 100, "pk:divine-n2");
    state.markLive("divine-n3", "hash-c", "[3]", "e3", 100, "pk:divine-n3");
    state.markDeleted("divine-n2", 200);
    state.markDeleted("divine-n3", 200);
    expect(state.counts()).toEqual({ live: 1, deleted: 2 });

    state.markLive("divine-n3", "hash-d", "[4]", "e4", 300, "pk:divine-n3");
    expect(state.counts()).toEqual({ live: 2, deleted: 1 });
  });
});

describe("events", () => {
  it("acceptedOn is true only for ok=true results on that relay", () => {
    state.recordResult(result({ eventId: "e1", relay: DCOSL, ok: true }));
    state.recordResult(result({ eventId: "e1", relay: SEARCH, ok: false, message: "blocked: no" }));
    state.recordResult(result({ eventId: "e2", relay: DCOSL, ok: false, message: "rate-limited" }));

    expect(state.acceptedOn("e1", DCOSL)).toBe(true);
    expect(state.acceptedOn("e1", SEARCH)).toBe(false);
    expect(state.acceptedOn("e2", DCOSL)).toBe(false);
    expect(state.acceptedOn("e2", SEARCH)).toBe(false);
    expect(state.acceptedOn("never-seen", DCOSL)).toBe(false);
  });

  it("acceptedAnywhere is true once any relay has accepted the event", () => {
    state.recordResult(result({ eventId: "e1", relay: SEARCH, ok: false, message: "pending" }));
    expect(state.acceptedAnywhere("e1")).toBe(false);

    state.recordResult(result({ eventId: "e1", relay: DCOSL, ok: true }));
    expect(state.acceptedAnywhere("e1")).toBe(true);
    expect(state.acceptedAnywhere("never-seen")).toBe(false);
  });

  it("recording the same event and relay again updates ok instead of adding a row", () => {
    state.recordResult(result({ eventId: "e1", relay: DCOSL, ok: false, message: "timeout", runId: "run-1" }));
    state.recordResult(result({ eventId: "e1", relay: DCOSL, ok: true, message: "", runId: "run-2" }));

    expect(state.acceptedOn("e1", DCOSL)).toBe(true);
    expect(state.versionsOf("divine-n1")).toEqual(["e1"]);
    expect(state.runs()).toEqual([{ runId: "run-2", relay: DCOSL, ok: 1, failed: 0 }]);
  });

  it("a later failure overwrites an earlier acceptance of the same pair", () => {
    state.recordResult(result({ eventId: "e1", ok: true }));
    state.recordResult(result({ eventId: "e1", ok: false, message: "dropped" }));

    expect(state.acceptedOn("e1", DCOSL)).toBe(false);
  });

  it("versionsOf lists distinct kind 39999 ids across relays, ok or not, oldest first", () => {
    state.recordResult(result({ eventId: "bb", createdAt: 2000, relay: DCOSL }));
    state.recordResult(result({ eventId: "bb", createdAt: 2000, relay: SEARCH, ok: false, message: "x" }));
    state.recordResult(result({ eventId: "aa", createdAt: 2000, relay: DCOSL }));
    state.recordResult(result({ eventId: "zz", createdAt: 1000, relay: SEARCH, ok: false, message: "x" }));
    state.recordResult(result({ eventId: "del", kind: 5, createdAt: 500, relay: DCOSL }));
    state.recordResult(result({ eventId: "other", d: "divine-n2", createdAt: 100, relay: DCOSL }));

    expect(state.versionsOf("divine-n1")).toEqual(["zz", "aa", "bb"]);
    expect(state.versionsOf("divine-n2")).toEqual(["other"]);
    expect(state.versionsOf("divine-n3")).toEqual([]);
  });

  it("versionsOf returns an id once even if relays were told different created_at values", () => {
    state.recordResult(result({ eventId: "e1", createdAt: 1000, relay: DCOSL }));
    state.recordResult(result({ eventId: "e1", createdAt: 1001, relay: SEARCH }));

    expect(state.versionsOf("divine-n1")).toEqual(["e1"]);
  });

  it("runs aggregates ok and failed per run and relay", () => {
    state.recordResult(result({ eventId: "e1", runId: "run-1", relay: DCOSL, ok: true }));
    state.recordResult(result({ eventId: "e2", runId: "run-1", relay: DCOSL, ok: true }));
    state.recordResult(result({ eventId: "e3", runId: "run-1", relay: DCOSL, ok: false, message: "x" }));
    state.recordResult(result({ eventId: "e1", runId: "run-1", relay: SEARCH, ok: false, message: "x" }));
    state.recordResult(result({ eventId: "e4", runId: "run-2", relay: SEARCH, ok: true }));

    expect(state.runs()).toEqual([
      { runId: "run-1", relay: DCOSL, ok: 2, failed: 1 },
      { runId: "run-1", relay: SEARCH, ok: 0, failed: 1 },
      { runId: "run-2", relay: SEARCH, ok: 1, failed: 0 },
    ]);
  });

  it("runs is empty before anything is recorded", () => {
    expect(state.runs()).toEqual([]);
  });
});

describe("openState on a file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "divinebot-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the missing parent directories", () => {
    const path = join(dir, "nested", "state", "state.sqlite");

    const s = openState(path);
    s.close();

    expect(statSync(join(dir, "nested", "state")).isDirectory()).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
  });

  it("keeps data when the same file is reopened", () => {
    const path = join(dir, "state", "state.sqlite");

    const first = openState(path);
    first.recordResult(result({ eventId: "e1" }));
    first.markLive("divine-n1", "hash-a", "[1]", "e1", 100, "pk:divine-n1");
    first.close();

    const second = openState(path);
    try {
      expect(second.liveItems().get("divine-n1")?.contentHash).toBe("hash-a");
      expect(second.versionsOf("divine-n1")).toEqual(["e1"]);
      expect(second.acceptedOn("e1", DCOSL)).toBe(true);
    } finally {
      second.close();
    }
  });

  it("uses WAL for a file database", () => {
    const path = join(dir, "state.sqlite");
    openState(path).close();

    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      raw.close();
    }
  });

  it("sets first_seen once and moves last_changed on every markLive and markDeleted", () => {
    const path = join(dir, "state.sqlite");
    const s = openState(path);
    s.markLive("divine-n1", "hash-a", "[1]", "e1", 100, "pk:divine-n1");
    s.markLive("divine-n1", "hash-b", "[2]", "e2", 200, "pk:divine-n1");
    s.markDeleted("divine-n1", 300);
    s.close();

    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare("SELECT * FROM items WHERE d = ?").get("divine-n1")).toEqual({
        d: "divine-n1",
        address: "pk:divine-n1",
        status: "deleted",
        content_hash: "hash-b",
        tags_json: "[2]",
        latest_event_id: "e2",
        first_seen: 100,
        last_changed: 300,
      });
    } finally {
      raw.close();
    }
  });

  it("rejects a status other than live or deleted", () => {
    const path = join(dir, "state.sqlite");
    openState(path).close();

    const raw = new Database(path);
    try {
      expect(() =>
        raw
          .prepare("INSERT INTO items VALUES ('d', 'a', 'gone', 'h', '[]', 'e', 1, 1)")
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      raw.close();
    }
  });
});

const PK = "a".repeat(64);
const ADDR = `${PK}:vid-1`;

/** A source event with only the fields the state reads; the id is padded to 64 hex chars. */
function source(over: { id?: string; createdAt?: number; d?: string; pubkey?: string } = {}): NostrEvent {
  return {
    id: (over.id ?? "b1").padEnd(64, "0"),
    pubkey: over.pubkey ?? PK,
    created_at: over.createdAt ?? 1000,
    kind: 34236,
    tags: [["d", over.d ?? "vid-1"], ["title", "Hello"]],
    content: "",
    sig: "c".repeat(128),
  };
}

describe("sources", () => {
  it("a first upsert is new and round-trips the event", () => {
    const ev = source();
    expect(state.upsertSource(ev, "native", null, 500)).toBe("new");

    expect(state.source(ADDR)).toEqual({
      address: ADDR,
      eventId: ev.id,
      createdAt: 1000,
      event: ev,
      class: "native",
      status: "active",
      skipReason: null,
      lastSeen: 500,
    });
    expect(state.source("nope")).toBeUndefined();
  });

  it("a newer version is updated and replaces the event", () => {
    state.upsertSource(source({ id: "b1", createdAt: 1000 }), "native", null, 500);
    const newer = source({ id: "b2", createdAt: 2000 });

    expect(state.upsertSource(newer, "native", "no-media", 600)).toBe("updated");

    const row = state.source(ADDR)!;
    expect(row.eventId).toBe(newer.id);
    expect(row.createdAt).toBe(2000);
    expect(row.event).toEqual(newer);
    expect(row.skipReason).toBe("no-media");
    expect(row.lastSeen).toBe(600);
  });

  it("an older version is older and changes nothing", () => {
    const current = source({ id: "b2", createdAt: 2000 });
    state.upsertSource(current, "native", null, 500);

    expect(state.upsertSource(source({ id: "b1", createdAt: 1000 }), "vine", "x", 900)).toBe("older");

    expect(state.source(ADDR)).toMatchObject({ eventId: current.id, class: "native", skipReason: null, lastSeen: 500 });
  });

  it("the same event again is same, and refreshes last_seen, class and skip reason", () => {
    const ev = source();
    state.upsertSource(ev, "native", null, 500);

    expect(state.upsertSource(ev, "native", "no-media", 700)).toBe("same");

    expect(state.source(ADDR)).toMatchObject({ eventId: ev.id, lastSeen: 700, skipReason: "no-media" });
  });

  it("equal created_at keeps the lower id", () => {
    state.upsertSource(source({ id: "b5", createdAt: 1000 }), "native", null, 500);

    expect(state.upsertSource(source({ id: "b9", createdAt: 1000 }), "native", null, 600)).toBe("older");
    expect(state.source(ADDR)?.eventId).toBe("b5".padEnd(64, "0"));

    expect(state.upsertSource(source({ id: "b2", createdAt: 1000 }), "native", null, 700)).toBe("updated");
    expect(state.source(ADDR)?.eventId).toBe("b2".padEnd(64, "0"));
  });

  it("a deleted source stays deleted when the same event is seen again, and a newer version revives it", () => {
    state.upsertSource(source({ id: "b1", createdAt: 1000 }), "native", null, 500);
    state.setSourceStatus(ADDR, "deleted", 600);

    state.upsertSource(source({ id: "b1", createdAt: 1000 }), "native", null, 700);
    expect(state.source(ADDR)?.status).toBe("deleted");

    state.upsertSource(source({ id: "b2", createdAt: 2000 }), "native", null, 800);
    expect(state.source(ADDR)?.status).toBe("active");
  });

  it("a vanished source seen again becomes active, by upsert or by touch", () => {
    state.upsertSource(source(), "native", null, 500);
    state.setSourceStatus(ADDR, "vanished", 600);
    state.upsertSource(source(), "native", null, 700);
    expect(state.source(ADDR)?.status).toBe("active");

    state.setSourceStatus(ADDR, "vanished", 800);
    state.touchSources([ADDR], 900);
    expect(state.source(ADDR)).toMatchObject({ status: "active", lastSeen: 900 });
  });

  it("setSourceStatus on an unknown address does nothing", () => {
    state.setSourceStatus("nope", "deleted", 1);
    expect(state.sources()).toEqual([]);
  });

  it("sources filters by status, class and eligibleOnly, ordered by address", () => {
    state.upsertSource(source({ id: "b1", d: "v3" }), "native", null, 1);
    state.upsertSource(source({ id: "b2", d: "v1" }), "native", "no-media", 1);
    state.upsertSource(source({ id: "b3", d: "v2" }), "vine", null, 1);
    state.upsertSource(source({ id: "b4", d: "v4" }), "native", null, 1);
    state.setSourceStatus(`${PK}:v4`, "deleted", 2);
    const addrs = (rows: { address: string }[]) => rows.map((r) => r.address.slice(65));

    expect(addrs(state.sources())).toEqual(["v1", "v2", "v3", "v4"]);
    expect(addrs(state.sources({ status: "active" }))).toEqual(["v1", "v2", "v3"]);
    expect(addrs(state.sources({ status: "active", eligibleOnly: true }))).toEqual(["v2", "v3"]);
    expect(addrs(state.sources({ class: "native" }))).toEqual(["v1", "v3", "v4"]);
    expect(addrs(state.sources({ status: "active", class: "native", eligibleOnly: true }))).toEqual(["v3"]);
    expect(addrs(state.sources({ status: "deleted" }))).toEqual(["v4"]);
  });

  it("touchSources moves last_seen for the named addresses only", () => {
    state.upsertSource(source({ d: "v1" }), "native", null, 1);
    state.upsertSource(source({ d: "v2" }), "native", null, 1);

    state.touchSources([`${PK}:v1`, `${PK}:unknown`], 50);

    expect(state.source(`${PK}:v1`)?.lastSeen).toBe(50);
    expect(state.source(`${PK}:v2`)?.lastSeen).toBe(1);
    state.touchSources([], 99);
  });

  it("sourceByEventId finds the source whose stored version has that id, and none for a replaced version", () => {
    const v1 = source({ d: "v1" });
    state.upsertSource(v1, "native", null, 1);
    expect(state.sourceByEventId(v1.id)?.address).toBe(`${PK}:v1`);
    expect(state.sourceByEventId("nope")).toBeUndefined();

    const v2 = { ...v1, id: "b".repeat(64), created_at: v1.created_at + 5 };
    state.upsertSource(v2, "native", null, 2);
    expect(state.sourceByEventId(v2.id)?.eventId).toBe(v2.id);
    expect(state.sourceByEventId(v1.id)).toBeUndefined();
  });

  it("sourceAddresses lists addresses only, filtered and sorted", () => {
    state.upsertSource(source({ d: "v2" }), "native", null, 1);
    state.upsertSource(source({ d: "v1" }), "native", null, 1);
    state.upsertSource(source({ d: "v3" }), "vine", "classic-vine", 1);
    state.setSourceStatus(`${PK}:v2`, "deleted", 2);

    expect(state.sourceAddresses()).toEqual([`${PK}:v1`, `${PK}:v2`, `${PK}:v3`]);
    expect(state.sourceAddresses({ status: "active", class: "native" })).toEqual([`${PK}:v1`]);
  });

  it("transaction commits every write together and rolls all back when the function throws", () => {
    const n = state.transaction(() => {
      state.upsertSource(source({ d: "v1" }), "native", null, 1);
      state.upsertSource(source({ d: "v2" }), "native", null, 1);
      state.setCursor("videos", 5);
      return 2;
    });
    expect(n).toBe(2);
    expect(state.sourceAddresses()).toHaveLength(2);
    expect(state.cursor("videos")).toBe(5);

    expect(() =>
      state.transaction(() => {
        state.upsertSource(source({ d: "v3" }), "native", null, 1);
        state.setCursor("videos", 9);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(state.source(`${PK}:v3`)).toBeUndefined();
    expect(state.cursor("videos")).toBe(5);
  });

  it("rejects an unknown class or status in the table", () => {
    const path = join(mkdtempSync(join(tmpdir(), "divinebot-state-")), "s.sqlite");
    openState(path).close();
    const raw = new Database(path);
    try {
      const insert = (cls: string, status: string) =>
        raw.prepare("INSERT INTO sources VALUES ('a', 'e', 1, '{}', ?, ?, NULL, 1, 1)").run(cls, status);
      expect(() => insert("other", "active")).toThrow(/CHECK/);
      expect(() => insert("native", "skipped")).toThrow(/CHECK/);
    } finally {
      raw.close();
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});

describe("cursors", () => {
  it("are undefined until set, then round-trip and overwrite", () => {
    expect(state.cursor("videos")).toBeUndefined();
    state.setCursor("videos", 1700000000);
    state.setCursor("deletions", 5);
    expect(state.cursor("videos")).toBe(1700000000);
    expect(state.cursor("deletions")).toBe(5);
    expect(state.cursor("last_sweep")).toBeUndefined();

    state.setCursor("videos", 1800000000);
    expect(state.cursor("videos")).toBe(1800000000);
  });

  it("a cursor of 0 is returned as 0, not undefined", () => {
    state.setCursor("last_sweep", 0);
    expect(state.cursor("last_sweep")).toBe(0);
  });
});

describe("profiles, NIP-05 and media", () => {
  it("profile round-trips and is replaced by a later put", () => {
    expect(state.profile(PK)).toBeUndefined();
    state.putProfile(PK, { name: "Ana", display_name: "Ana \u2728" }, 100, 200);
    expect(state.profile(PK)).toEqual({ content: { name: "Ana", display_name: "Ana \u2728" }, createdAt: 100, fetchedAt: 200 });

    state.putProfile(PK, { name: "Ana B" }, 300, 400);
    expect(state.profile(PK)).toEqual({ content: { name: "Ana B" }, createdAt: 300, fetchedAt: 400 });
  });

  it("nip05 stores a pubkey or a null for a failed check", () => {
    expect(state.nip05("ana@example.com")).toBeUndefined();
    state.putNip05("ana@example.com", PK, 10);
    expect(state.nip05("ana@example.com")).toEqual({ pubkey: PK, checkedAt: 10 });

    state.putNip05("ana@example.com", null, 20);
    expect(state.nip05("ana@example.com")).toEqual({ pubkey: null, checkedAt: 20 });
  });

  it("media round-trips pass and fail", () => {
    expect(state.media("https://m/x")).toBeUndefined();
    state.putMedia("https://m/x", "pass", 200, "video/mp4", 5);
    expect(state.media("https://m/x")).toEqual({ status: "pass", httpStatus: 200, contentType: "video/mp4", checkedAt: 5 });

    state.putMedia("https://m/x", "fail", 404, "", 9);
    expect(state.media("https://m/x")).toEqual({ status: "fail", httpStatus: 404, contentType: "", checkedAt: 9 });
  });

  it("mediaDue returns urls checked before the cutoff, oldest first, up to the limit", () => {
    const now = 100 * 86400;
    const cutoff = now - 30 * 86400;
    state.putMedia("https://m/fresh", "pass", 200, "video/mp4", now - 86400);
    state.putMedia("https://m/edge", "pass", 200, "video/mp4", cutoff);
    state.putMedia("https://m/old2", "pass", 200, "video/mp4", cutoff - 50);
    state.putMedia("https://m/old1", "fail", 404, "", cutoff - 500);
    state.putMedia("https://m/old3", "pass", 200, "video/mp4", cutoff - 10);

    expect(state.mediaDue(cutoff, 10)).toEqual(["https://m/old1", "https://m/old2", "https://m/old3"]);
    expect(state.mediaDue(cutoff, 2)).toEqual(["https://m/old1", "https://m/old2"]);
    expect(state.mediaDue(0, 10)).toEqual([]);
  });
});

describe("liveItems with the diff", () => {
  it("is accepted by diffItems and carries the address", () => {
    state.markLive("divine-n1", "hash-a", "[]", "e1", 100, "pk:divine-n1");

    const diff = diffItems(new Map(), state.liveItems(), { detectGone: true });

    expect(diff.gone).toEqual(["divine-n1"]);
    expect(state.liveItems().get("divine-n1")?.address).toBe("pk:divine-n1");
  });
});
