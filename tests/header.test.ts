import { readFileSync } from "node:fs";
import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { rebroadcast } from "../src/commands/rebroadcast.js";
import { loadConfig, type Config } from "../src/config.js";
import { checkHeader, fetchHeader } from "../src/header.js";
import { startStubRelay } from "./stub-relay.js";

// The events below are the real signed ones dcosl serves. The relays are loopback stubs;
// nothing leaves this machine.

const header = JSON.parse(readFileSync("tests/fixtures/live-header.json", "utf8")) as NostrEvent;
const templates = readFileSync("tests/fixtures/live-templates.jsonl", "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as NostrEvent);
const base = loadConfig("config.json");
const SEARCH = "include:spam";

/** A copy of the live header with its tags changed by `edit`. */
function withTags(edit: (tags: string[][]) => string[][]): NostrEvent {
  return { ...header, tags: edit(header.tags.map((t) => [...t])) };
}

describe("checkHeader", () => {
  it("accepts the live header", () => {
    expect(() => checkHeader(header, base)).not.toThrow();
  });

  it("throws when there is no header", () => {
    expect(() => checkHeader(null, base)).toThrow(`header ${base.headerCoordinate} not found`);
  });

  it("throws when the kind, author or d differ from the coordinate", () => {
    expect(() => checkHeader({ ...header, kind: 39999 }, base)).toThrow(/kind is 39999, expected 39998/);
    expect(() => checkHeader({ ...header, pubkey: "00".repeat(32) }, base)).toThrow(
      /author is 0{64}, expected b83a28b7/,
    );
    const otherD = withTags((tags) => tags.map((t) => (t[0] === "d" ? ["d", "other"] : t)));
    expect(() => checkHeader(otherD, base)).toThrow(/d is "other", expected "divine-videos"/);
  });

  it("throws, naming both orders, when the required fields are swapped", () => {
    const swapped = withTags((tags) => {
      const [a, b] = [tags.findIndex((t) => t[1] === "title" && t[0] === "required"), tags.findIndex((t) => t[1] === "video" && t[0] === "required")];
      [tags[a], tags[b]] = [tags[b]!, tags[a]!];
      return tags;
    });
    expect(() => checkHeader(swapped, base)).toThrow(/required fields are \[video, title\], expected \[title, video\]/);
  });

  it("throws when a required field is missing or extra", () => {
    const missing = withTags((tags) => tags.filter((t) => !(t[0] === "required" && t[1] === "video")));
    expect(() => checkHeader(missing, base)).toThrow(/required fields are \[title\], expected \[title, video\]/);
    const extra = withTags((tags) => [...tags, ["required", "sha256", "x"]]);
    expect(() => checkHeader(extra, base)).toThrow(/required fields are \[title, video, sha256\]/);
  });

  it("throws, naming the field, when a link points to a different template", () => {
    const wrong = withTags((tags) =>
      tags.map((t) => (t[0] === "link" && t[4] === "divine-id" ? ["link", "ab".repeat(32), ...t.slice(2)] : t)),
    );
    expect(() => checkHeader(wrong, base)).toThrow(
      new RegExp(`link for divine-id points to template ${"ab".repeat(32)}, expected ${base.templateIds["divine-video"]}`),
    );
    const wrongProfile = withTags((tags) =>
      tags.map((t) => (t[0] === "link" && t[4] === "creator-npub" ? ["link", "cd".repeat(32), ...t.slice(2)] : t)),
    );
    expect(() => checkHeader(wrongProfile, base)).toThrow(/link for creator-npub points to template (cd){32}/);
  });

  it("throws when a link is missing or binds the wrong template field", () => {
    const missing = withTags((tags) => tags.filter((t) => !(t[0] === "link" && t[4] === "creator-npub")));
    expect(() => checkHeader(missing, base)).toThrow(/no link binds npub to creator-npub/);
    const wrongBind = withTags((tags) =>
      tags.map((t) => (t[0] === "link" && t[4] === "divine-id" ? [t[0], t[1]!, t[2]!, "uuid", t[4]!] : t)),
    );
    expect(() => checkHeader(wrongBind, base)).toThrow(/link for divine-id binds uuid, expected id/);
  });
});

describe("fetchHeader", () => {
  it("returns the matching header and sends the search string", async () => {
    const filters: Record<string, unknown>[] = [];
    const stub = await startStubRelay(
      () => {},
      (received, ctx) => {
        filters.push(...received);
        ctx.send(header);
        ctx.eose();
      },
    );
    try {
      const found = await fetchHeader(stub.url, base.headerCoordinate, 5_000, SEARCH);
      // The client marks an event it verified with a symbol key; compare what goes on the wire.
      expect(JSON.parse(JSON.stringify(found))).toEqual(header);
      expect(filters).toEqual([
        { kinds: [39998], authors: [header.pubkey], "#d": ["divine-videos"], search: SEARCH },
      ]);
    } finally {
      await stub.close();
    }
  });

  it("returns null when the relay has no header", async () => {
    const stub = await startStubRelay(() => {}, (_f, ctx) => ctx.eose());
    try {
      expect(await fetchHeader(stub.url, base.headerCoordinate, 5_000)).toBeNull();
    } finally {
      await stub.close();
    }
  });
});

describe("rebroadcast", () => {
  /** A source relay that serves `events` by header coordinate or by id, with search required. */
  async function run(events: NostrEvent[], toRelay = "search", mutate: (cfg: Config) => void = () => {}) {
    const filters: Record<string, unknown>[] = [];
    const source = await startStubRelay(
      () => {},
      (received, ctx) => {
        filters.push(...received);
        for (const f of received) {
          if (typeof f.search !== "string") return ctx.closed("auth-required: search is needed");
          const ids = f.ids as string[] | undefined;
          for (const ev of events) {
            if (ids !== undefined ? ids.includes(ev.id) : (f.kinds as number[] | undefined)?.includes(ev.kind) && ev.kind === 39998) {
              ctx.send(ev);
            }
          }
        }
        ctx.eose();
      },
    );
    const target = await startStubRelay((_ev, ctx) => ctx.reply(true, ""));
    const cfg: Config = {
      ...base,
      relays: { dcosl: source.url, search: target.url },
      relayReadSearch: { dcosl: SEARCH },
      headerRelay: "dcosl",
    };
    mutate(cfg);
    try {
      const result = await rebroadcast(cfg, toRelay).catch((e: Error) => e);
      return { filters, target, source, result };
    } finally {
      await source.close();
      await target.close();
    }
  }

  it("publishes the header and both templates to the target, unchanged", async () => {
    const { filters, target, result } = await run([header, ...templates]);

    expect(Array.isArray(result) ? result.map((r) => r.eventId).sort() : result).toEqual(
      [header.id, ...templates.map((t) => t.id)].sort(),
    );
    expect(Array.isArray(result) && result.every((r) => r.ok)).toBe(true);
    // Byte-identical: the same events, not re-signed copies.
    expect(target.received).toHaveLength(3);
    for (const ev of [header, ...templates]) {
      expect(target.received.find((r) => r.id === ev.id)).toEqual(ev);
    }
    // Every read carried the header relay's search string.
    expect(filters.every((f) => f.search === SEARCH)).toBe(true);
  });

  it("returns the target's refusal for an event without stopping the others", async () => {
    const source = await startStubRelay(
      () => {},
      (received, ctx) => {
        for (const f of received) {
          const ids = f.ids as string[] | undefined;
          for (const ev of [header, ...templates]) if (ids ? ids.includes(ev.id) : ev.kind === 39998) ctx.send(ev);
        }
        ctx.eose();
      },
    );
    const target = await startStubRelay((ev, ctx) => ctx.reply(ev.kind !== 9999 || ev.id !== templates[0]!.id, "blocked: no"));
    const cfg: Config = { ...base, relays: { dcosl: source.url, search: target.url }, relayReadSearch: undefined };
    try {
      const results = await rebroadcast(cfg, "search");
      expect(results).toHaveLength(3);
      expect(results.find((r) => r.eventId === templates[0]!.id)).toMatchObject({ ok: false });
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      expect(target.received).toHaveLength(3);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it("publishes nothing when a template cannot be read", async () => {
    const { target, result } = await run([header, templates[0]!]);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain(templates[1]!.id);
    expect(target.received).toEqual([]);
    expect(target.connections).toBe(0);
  });

  it("publishes nothing when the header is missing", async () => {
    const { target, result } = await run(templates);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/not found/);
    expect(target.received).toEqual([]);
  });

  it("publishes nothing when the header fails the check", async () => {
    // Re-signed, because the reading client drops an event whose signature does not verify.
    const secret = generateSecretKey();
    const bad = finalizeEvent(
      { kind: 39998, created_at: header.created_at, content: "", tags: header.tags.filter((t) => !(t[0] === "required" && t[1] === "video")) },
      secret,
    );
    const { target, result } = await run([bad, ...templates], "search", (cfg) => {
      cfg.headerCoordinate = `39998:${bad.pubkey}:divine-videos`;
    });
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/required fields are \[title\]/);
    expect(target.received).toEqual([]);
  });

  it("refuses to copy onto the header relay", async () => {
    const { result, target } = await run([header, ...templates], "dcosl");
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/dcosl is the header relay/);
    expect(target.received).toEqual([]);
  });
});
