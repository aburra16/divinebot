import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "nostr-tools/utils";
import * as nip19 from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profilePublish, readCurrentProfile } from "../src/commands/profile-publish.js";
import { loadConfig, type Config } from "../src/config.js";
import { startStubRelay, type StubContext, type StubRelay } from "./stub-relay.js";

// Every relay here is a stub on loopback or the refused port 9: nothing leaves this machine.
const REFUSED = "ws://127.0.0.1:9";

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const T = 1_700_000_000;
const EXAMPLE = {
  name: "divinebot",
  display_name: "Divine Videos",
  about: "Automated account. Lists videos.",
  bot: true,
};

let dir: string;
let keyPath: string;
let profilePath: string;
let stubs: StubRelay[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divinebot-profile-"));
  keyPath = join(dir, "curator.key");
  writeFileSync(keyPath, `${nip19.nsecEncode(secret)}\n`);
  chmodSync(keyPath, 0o600);
  profilePath = join(dir, "profile.json");
  writeProfile(EXAMPLE);
  stubs = [];
});

afterEach(async () => {
  for (const s of stubs) await s.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeProfile(content: unknown): void {
  writeFileSync(profilePath, typeof content === "string" ? content : JSON.stringify(content));
}

const acceptAll = (_: unknown, ctx: StubContext): void => ctx.reply(true, "");

async function stub(
  onEvent: (ev: Event, ctx: StubContext) => void = acceptAll,
  onReq?: Parameters<typeof startStubRelay>[1],
): Promise<StubRelay> {
  const s = await startStubRelay(onEvent, onReq);
  stubs.push(s);
  return s;
}

function config(profileRelays: string[]): Config {
  return {
    ...loadConfig("config.json"),
    curatorPubkey: pubkey,
    profileRelays,
    publish: { eventsPerSecond: 1000, okTimeoutMs: 2_000 },
  };
}

function kind0(content: unknown, createdAt = T - 100, key = secret): Event {
  return finalizeEvent(
    { kind: 0, created_at: createdAt, tags: [], content: typeof content === "string" ? content : JSON.stringify(content) },
    key,
  );
}

const noPassphrase = (): Promise<string> => {
  throw new Error("the passphrase was asked for, but the key is not encrypted");
};

function opts(over: Parameters<typeof profilePublish>[2] = {}): NonNullable<Parameters<typeof profilePublish>[2]> {
  return { keyPath, askPassphrase: noPassphrase, now: () => T, fetchCurrent: async () => null, ...over };
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return (err as Error).message;
  }
  throw new Error("expected the call to throw");
}

describe("profilePublish", () => {
  it("publishes a kind 0 by the curator, with the profile.json fields as content", async () => {
    const a = await stub();
    const { eventId, results } = await profilePublish(config([a.url]), profilePath, opts());
    expect(a.received).toHaveLength(1);
    const ev = a.received[0]!;
    expect(ev.kind).toBe(0);
    expect(ev.pubkey).toBe(pubkey);
    expect(ev.id).toBe(eventId);
    expect(ev.created_at).toBe(T);
    expect(ev.tags).toEqual([]);
    expect(verifyEvent(ev)).toBe(true);
    expect(JSON.parse(ev.content)).toEqual(EXAMPLE);
    expect(results).toEqual({ [a.url]: { ok: true, message: "" } });
  });

  it("keeps fields only the existing profile has, and lets profile.json win on the rest", async () => {
    const a = await stub();
    const existing = kind0({ name: "old name", picture: "https://example.com/p.png", about: "old about" });
    const fetchCurrent = vi.fn(async () => existing);
    await profilePublish(config([a.url]), profilePath, opts({ fetchCurrent }));
    expect(fetchCurrent).toHaveBeenCalledWith([a.url], pubkey);
    expect(JSON.parse(a.received[0]!.content)).toEqual({ ...EXAMPLE, picture: "https://example.com/p.png" });
  });

  it("treats an existing profile whose content is not a JSON object as empty", async () => {
    for (const content of ["not json {", "[1,2]", "null", '"text"']) {
      const a = await stub();
      await profilePublish(config([a.url]), profilePath, opts({ fetchCurrent: async () => kind0(content) }));
      expect(JSON.parse(a.received[0]!.content)).toEqual(EXAMPLE);
    }
  });

  it("is newer than the profile it replaces even when the clock is not", async () => {
    const a = await stub();
    await profilePublish(config([a.url]), profilePath, opts({ fetchCurrent: async () => kind0({}, T + 50) }));
    expect(a.received[0]!.created_at).toBe(T + 51);
  });

  it("publishes to every profile relay in parallel and reports each; one failing stops no one", async () => {
    const ok = await stub();
    const rejecting = await stub((_, ctx) => ctx.reply(false, "blocked: not allowed"));
    const { results } = await profilePublish(config([ok.url, rejecting.url, REFUSED]), profilePath, opts());
    expect(results[ok.url]).toEqual({ ok: true, message: "" });
    expect(results[rejecting.url]).toEqual({ ok: false, message: "blocked: not allowed" });
    expect(results[REFUSED]!.ok).toBe(false);
    expect(results[REFUSED]!.message).toContain(REFUSED);
    expect(ok.received).toHaveLength(1);
    expect(rejecting.received).toHaveLength(1);
  });

  describe("refusals", () => {
    it("refuses a profile without bot: true, including the string \"true\"", async () => {
      const a = await stub();
      for (const bot of [undefined, false, "true", 1]) {
        const { bot: _drop, ...rest } = EXAMPLE;
        writeProfile(bot === undefined ? rest : { ...rest, bot });
        const message = await failure(() => profilePublish(config([a.url]), profilePath, opts()));
        expect(message).toContain('"bot": true');
      }
      expect(a.received).toHaveLength(0);
    });

    it("refuses a missing or empty name or about", async () => {
      const a = await stub();
      for (const [field, value] of [["name", undefined], ["name", ""], ["name", "  "], ["name", 5], ["about", undefined], ["about", ""]] as const) {
        const copy: Record<string, unknown> = { ...EXAMPLE };
        if (value === undefined) delete copy[field];
        else copy[field] = value;
        writeProfile(copy);
        const message = await failure(() => profilePublish(config([a.url]), profilePath, opts()));
        expect(message).toContain(field === "name" ? "needs a name" : "needs an about");
      }
      expect(a.received).toHaveLength(0);
    });

    it("refuses a missing file, invalid JSON and a non-object", async () => {
      const a = await stub();
      const missing = join(dir, "nope.json");
      expect(await failure(() => profilePublish(config([a.url]), missing, opts()))).toContain("not found");
      writeProfile("{ nope");
      expect(await failure(() => profilePublish(config([a.url]), profilePath, opts()))).toContain("not valid JSON");
      writeProfile("[1]");
      expect(await failure(() => profilePublish(config([a.url]), profilePath, opts()))).toContain("must be a JSON object");
    });

    it("checks the profile before loading the key", async () => {
      writeProfile({ ...EXAMPLE, bot: false });
      const message = await failure(() =>
        profilePublish(config([]), profilePath, opts({ keyPath: join(dir, "no-such.key") })),
      );
      expect(message).toContain('"bot": true');
    });

    it("refuses a key that is not the curator's before anything is sent or read", async () => {
      const a = await stub();
      const other = generateSecretKey();
      writeFileSync(keyPath, `${nip19.nsecEncode(other)}\n`);
      chmodSync(keyPath, 0o600);
      const fetchCurrent = vi.fn(async () => null);
      const message = await failure(() => profilePublish(config([a.url]), profilePath, opts({ fetchCurrent })));
      expect(message).toContain(pubkey);
      expect(message).not.toContain(nip19.nsecEncode(other));
      expect(message).not.toContain(bytesToHex(other));
      expect(fetchCurrent).not.toHaveBeenCalled();
      expect(a.connections).toBe(0);
      expect(a.received).toHaveLength(0);
    });

    it("never puts the key in a result", async () => {
      const a = await stub();
      const out = await profilePublish(config([a.url]), profilePath, opts());
      const text = JSON.stringify(out);
      expect(text).not.toContain("nsec1");
      expect(text).not.toContain(bytesToHex(secret));
    });
  });
});

describe("default fetchCurrent", () => {
  const reqStub = (events: Event[]) =>
    stub(acceptAll, (_filters, ctx) => {
      for (const ev of events) ctx.send(ev);
      ctx.eose();
    });

  it("asks each relay for the curator's kind 0 and keeps the newest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const filters: Record<string, unknown>[][] = [];
    const older = await stub(acceptAll, (f, ctx) => {
      filters.push(f);
      ctx.send(kind0({ picture: "old.png" }, T - 200));
      ctx.eose();
    });
    const newest = await reqStub([kind0({ picture: "new.png" }, T - 50)]);
    const got = await readCurrentProfile(2_000)([older.url, newest.url, REFUSED], pubkey);
    expect(JSON.parse(got!.content)).toEqual({ picture: "new.png" });
    expect(filters[0]).toEqual([{ kinds: [0], authors: [pubkey] }]);
  });

  it("ignores events that are not the curator's kind 0", async () => {
    const stranger = generateSecretKey();
    const a = await reqStub([kind0({ picture: "x" }, T, stranger)]);
    expect(await readCurrentProfile(2_000)([a.url], pubkey)).toBeNull();
  });

  it("skips a relay that cannot be reached and merges onto what the others hold", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await reqStub([kind0({ picture: "kept.png" })]);
    const publishTo = await stub();
    // publishTo never answers a REQ, so the read of it waits out the (short) timeout.
    const cfg = { ...config([REFUSED, a.url, publishTo.url]), publish: { eventsPerSecond: 1000, okTimeoutMs: 400 } };
    await profilePublish(cfg, profilePath, {
      keyPath,
      askPassphrase: noPassphrase,
      now: () => T,
    });
    expect(JSON.parse(publishTo.received[0]!.content)).toEqual({ ...EXAMPLE, picture: "kept.png" });
  });

  it("refuses, naming the relays and sending nothing, when no relay can be read", async () => {
    const publishTo = await stub();
    // publishTo never answers a REQ, so the read of it times out; REFUSED cannot connect.
    const cfg = { ...config([REFUSED, publishTo.url]), publish: { eventsPerSecond: 1000, okTimeoutMs: 300 } };
    const message = await failure(() =>
      profilePublish(cfg, profilePath, { keyPath, askPassphrase: noPassphrase, now: () => T }),
    );
    expect(message).toContain("No profile relay could be read");
    expect(message).toContain(REFUSED);
    expect(message).toContain(publishTo.url);
    expect(message).toContain("nothing was published");
    expect(publishTo.received).toHaveLength(0);
  });

  it("publishes profile.json alone when the relays answer but hold no profile", async () => {
    const empty = await reqStub([]);
    const { results } = await profilePublish(config([empty.url]), profilePath, {
      keyPath,
      askPassphrase: noPassphrase,
      now: () => T,
    });
    expect(JSON.parse(empty.received[0]!.content)).toEqual(EXAMPLE);
    expect(results[empty.url]!.ok).toBe(true);
  });

  it("names each relay it skipped when others answered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await reqStub([kind0({ picture: "p.png" })]);
    const got = await readCurrentProfile(2_000)([REFUSED, a.url], pubkey);
    expect(JSON.parse(got!.content)).toEqual({ picture: "p.png" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(REFUSED));
  });
});
