import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verify, verifySummary, type RelayVerifyResult } from "../src/commands/verify.js";
import { loadConfig, type Config } from "../src/config.js";
import { openState, type State } from "../src/state.js";
import { startStubRelay, type StubRelay } from "./stub-relay.js";

// Relays here are stubs on loopback; NIP-11 is never fetched (the page size is injected).

const clean: RelayVerifyResult = {
  onRelay: 3,
  inState: 3,
  missing: [],
  extra: [],
  stale: [],
  extraCheck: "complete",
};

describe("verifySummary", () => {
  it("prints one line per relay and fails nothing when relays and state match", () => {
    expect(verifySummary({ dcosl: clean })).toEqual({
      lines: ["dcosl: on relay 3, in state 3, missing 0, extra 0, stale 0"],
      warnings: [],
      failed: [],
    });
  });

  it("warns about an incomplete extra check without failing the relay", () => {
    const summary = verifySummary({
      dcosl: { ...clean, extraCheck: "incomplete: more than 500 events share created_at 1700000000" },
    });
    expect(summary.warnings).toEqual([
      "dcosl: extra check incomplete: more than 500 events share created_at 1700000000",
    ]);
    expect(summary.failed).toEqual([]);
  });

  it("fails a relay with missing, extra or stale items, and lists them", () => {
    const summary = verifySummary({
      dcosl: { ...clean, missing: ["osm-node-1"] },
      search: { ...clean, extra: ["osm-node-2"], stale: ["osm-node-3"] },
      other: clean,
    });
    expect(summary.failed).toEqual(["dcosl", "search"]);
    expect(summary.lines).toEqual([
      "dcosl: on relay 3, in state 3, missing 1, extra 0, stale 0",
      "  missing: osm-node-1",
      "search: on relay 3, in state 3, missing 0, extra 1, stale 1",
      "  extra: osm-node-2",
      "  stale: osm-node-3",
      "other: on relay 3, in state 3, missing 0, extra 0, stale 0",
    ]);
  });

  it("fails a relay that could not be read", () => {
    const summary = verifySummary({
      dcosl: { ...clean, error: "cannot connect to ws://127.0.0.1:9 (connection failed)" },
    });
    expect(summary.lines).toEqual(["dcosl: cannot connect to ws://127.0.0.1:9 (connection failed)"]);
    expect(summary.failed).toEqual(["dcosl"]);
  });

  it("lists at most 20 values, then how many more", () => {
    const missing = Array.from({ length: 23 }, (_, i) => `d${i}`);
    const { lines } = verifySummary({ dcosl: { ...clean, missing } });
    expect(lines[1]).toBe(`  missing: ${missing.slice(0, 20).join(", ")} and 3 more`);
  });
});

describe("verify", () => {
  const secret = generateSecretKey();
  let state: State;
  let stubs: StubRelay[];

  beforeEach(() => {
    state = openState(":memory:");
    stubs = [];
  });

  afterEach(async () => {
    state.close();
    for (const s of stubs) await s.close();
  });

  it("reports an error instead of a missing item when a #d batch comes back full", async () => {
    const base = loadConfig("config.json");
    // A relay that keeps old versions: every REQ is answered with `limit` versions of one item.
    const relay = await startStubRelay(
      () => {},
      (filters, ctx) => {
        const limit = filters[0]!.limit as number;
        for (let i = 0; i < limit; i++) {
          ctx.send(
            finalizeEvent(
              {
                kind: 39999,
                created_at: 1_700_000_000 - i,
                content: "",
                tags: [["d", "osm-node-1"], ["z", base.headerCoordinate]],
              },
              secret,
            ),
          );
        }
        ctx.eose();
      },
    );
    stubs.push(relay);
    const cfg: Config = { ...base, curatorPubkey: getPublicKey(secret), relays: { dcosl: relay.url }, headerRelay: "dcosl" };
    for (const d of ["osm-node-1", "osm-node-2", "osm-node-3"]) state.markLive(d, "h", "[]", "a".repeat(64), 1, `${"e".repeat(64)}:${d}`);

    const result = await verify(cfg, state, { pageSize: 3 });

    expect(result.dcosl!.error).toMatch(/full page.*cannot tell/);
    expect(result.dcosl!.missing).toEqual([]);
  });
});

describe("verify with relayReadSearch", () => {
  const secret = generateSecretKey();
  const SEARCH = "include:spam";
  /** What vespa-relay answers a REQ that has no NIP-50 search field. */
  const AUTH_REQUIRED =
    "auth-required: this relay answers through a web of trust and has no house observer to lend you";
  let state: State;
  let stubs: StubRelay[];
  let base: Config;
  let events: NostrEvent[];

  beforeEach(() => {
    state = openState(":memory:");
    stubs = [];
    base = loadConfig("config.json");
    // Two live items, on the relay, and one deleted item, off it.
    events = ["osm-node-1", "osm-node-2"].map((d) =>
      finalizeEvent(
        { kind: 39999, created_at: 1_700_000_000, content: "", tags: [["d", d], ["z", base.headerCoordinate]] },
        secret,
      ),
    );
    for (const ev of events) state.markLive(ev.tags[0]![1]!, "h", "[]", ev.id, 1, `${"e".repeat(64)}:${ev.tags[0]![1]!}`);
    state.markLive("osm-node-3", "h", "[]", "c".repeat(64), 1, `${"e".repeat(64)}:osm-node-3`);
    state.markDeleted("osm-node-3", 2);
  });

  afterEach(async () => {
    state.close();
    for (const s of stubs) await s.close();
  });

  /** The events a REQ asks for: those with a `d` in its `#d` list, or all of them without one. */
  function answer(filter: Record<string, unknown>): NostrEvent[] {
    const ds = filter["#d"] as string[] | undefined;
    return events.filter((ev) => ds === undefined || ds.includes(ev.tags[0]![1]!));
  }

  /**
   * A stub relay that records every filter it receives. With `needsSearch` it behaves like
   * vespa-relay: CLOSED auth-required for a REQ whose filter has no `search`, EOSE for one that
   * has it. Otherwise it answers every REQ.
   */
  async function relay(needsSearch: boolean): Promise<{ stub: StubRelay; filters: Record<string, unknown>[] }> {
    const filters: Record<string, unknown>[] = [];
    const stub = await startStubRelay(
      () => {},
      (received, ctx) => {
        filters.push(...received);
        if (needsSearch && received.some((f) => typeof f.search !== "string")) return ctx.closed(AUTH_REQUIRED);
        for (const f of received) for (const ev of answer(f)) ctx.send(ev);
        ctx.eose();
      },
    );
    stubs.push(stub);
    return { stub, filters };
  }

  const configFor = (relays: Record<string, string>, relayReadSearch?: Record<string, string>): Config => ({
    ...base,
    curatorPubkey: getPublicKey(secret),
    relays,
    headerRelay: Object.keys(relays)[0]!,
    ...(relayReadSearch === undefined ? { relayReadSearch: undefined } : { relayReadSearch }),
  });

  it("sends search on every REQ to a relay with an entry, and on none to a relay without", async () => {
    const plain = await relay(false);
    const searchOnly = await relay(true);
    const cfg = configFor({ dcosl: plain.stub.url, search: searchOnly.stub.url }, { search: SEARCH });

    const result = await verify(cfg, state, { pageSize: 500 });

    // The relay with an entry is read in full: the live items by name, the deleted item by name,
    // then the listing, which takes a page that finds both items and a last page that finds none new.
    expect(result.search).toMatchObject({ onRelay: 2, inState: 2, missing: [], extra: [], stale: [] });
    expect(result.search!.error).toBeUndefined();
    expect(searchOnly.filters).toHaveLength(4);
    expect(searchOnly.filters.filter((f) => f["#d"] !== undefined)).toHaveLength(2);
    expect(searchOnly.filters.filter((f) => f["#d"] === undefined)).toHaveLength(2);
    for (const f of searchOnly.filters) {
      expect(f.search).toBe(SEARCH);
      expect(f).toMatchObject({ kinds: [39999], authors: [getPublicKey(secret)], "#z": [base.headerCoordinate] });
    }
    // The relay without one gets the same REQs and never a search field.
    expect(result.dcosl).toMatchObject({ onRelay: 2, inState: 2, missing: [], extra: [], stale: [] });
    expect(plain.filters).toHaveLength(4);
    for (const f of plain.filters) expect(Object.hasOwn(f, "search")).toBe(false);
  });

  it("reads a relay that wants search only when config gives it an entry", async () => {
    const searchOnly = await relay(true);
    const relays = { search: searchOnly.stub.url };

    const refused = await verify(configFor(relays), state, { pageSize: 500 });
    expect(refused.search!.error).toMatch(/closed the read.*auth-required/);

    const read = await verify(configFor(relays, { search: SEARCH }), state, { pageSize: 500 });
    expect(read.search!.error).toBeUndefined();
    expect(read.search).toMatchObject({ onRelay: 2, missing: [], extra: [], stale: [] });
  });

  it("keeps search on every batch and page of a read that takes more of them", async () => {
    const searchOnly = await relay(true);
    const cfg = configFor({ search: searchOnly.stub.url }, { search: SEARCH });

    // A page of 1 puts each live item in a batch of its own, so the read sends more REQs.
    const result = await verify(cfg, state, { pageSize: 1 });

    expect(result.search!.error).toBeUndefined();
    expect(searchOnly.filters.length).toBeGreaterThan(4);
    for (const f of searchOnly.filters) expect(f.search).toBe(SEARCH);
  });
});
