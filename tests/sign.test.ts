import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "nostr-tools/utils";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDirFor } from "../src/commands/build.js";
import { sign } from "../src/commands/sign.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Unsigned } from "../src/deletion.js";
import { defaultKeyPath, loadKey, loadPassphraseFile, promptPassphrase } from "../src/key.js";
import { writeManifest } from "./run-manifest.js";

// Wraps loadKey so a test can reach the array `sign` was handed and check it is zeroed.
vi.mock("../src/key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/key.js")>();
  return { ...actual, loadKey: vi.fn(actual.loadKey) };
});

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const hexSecret = bytesToHex(secret);
const nsec = nip19.nsecEncode(secret);
const PASSPHRASE = "correct horse battery staple";

let dir: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divinebot-sign-"));
  keyPath = join(dir, "curator.key");
  vi.mocked(loadKey).mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `text` to a key file with exactly `mode` (the umask cannot widen or narrow it). */
function writeKey(text: string, mode = 0o600, path = keyPath): string {
  writeFileSync(path, `${text}\n`);
  chmodSync(path, mode);
  return path;
}

const noPassphrase = (): Promise<string> => {
  throw new Error("the passphrase was asked for, but the key is not encrypted");
};

/** No secret form may ever show up in an error message. */
function expectNoSecret(message: string): void {
  expect(message).not.toContain("nsec1");
  expect(message).not.toContain("ncryptsec1");
  expect(message).not.toContain(hexSecret);
  expect(message).not.toContain(PASSPHRASE);
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

describe("loadKey", () => {
  it("loads an nsec file at mode 600", async () => {
    writeKey(nsec);
    const key = await loadKey(keyPath, pubkey, noPassphrase);
    expect(bytesToHex(key)).toBe(hexSecret);
  });

  it("loads an nsec file at mode 400, with surrounding whitespace", async () => {
    writeKey(`  ${nsec}  `, 0o400);
    expect(bytesToHex(await loadKey(keyPath, pubkey, noPassphrase))).toBe(hexSecret);
  });

  it.each(["644", "640", "604", "660", "666", "710"])(
    "refuses mode %s, naming the path and suggesting chmod 600, without the secret",
    async (octal) => {
      writeKey(nsec, parseInt(octal, 8));
      const message = await failure(() => loadKey(keyPath, pubkey, noPassphrase));
      expect(message).toMatch(/mode/);
      expect(message).toContain(keyPath);
      expect(message).toContain("chmod 600");
      expectNoSecret(message);
    },
  );

  it("refuses a key whose pubkey differs from the config, naming both pubkeys", async () => {
    writeKey(nsec);
    const other = getPublicKey(generateSecretKey());
    const message = await failure(() => loadKey(keyPath, other, noPassphrase));
    expect(message).toMatch(/does not match/);
    expect(message).toContain(pubkey);
    expect(message).toContain(other);
    expectNoSecret(message);
  });

  it("loads an ncryptsec with the passphrase from askPassphrase", async () => {
    writeKey(nip49.encrypt(secret, PASSPHRASE, 2));
    const askPassphrase = vi.fn(async () => PASSPHRASE);
    const key = await loadKey(keyPath, pubkey, askPassphrase);
    expect(bytesToHex(key)).toBe(hexSecret);
    expect(askPassphrase).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a passphrase when the key is a plain nsec", async () => {
    writeKey(nsec);
    const askPassphrase = vi.fn(async () => PASSPHRASE);
    await loadKey(keyPath, pubkey, askPassphrase);
    expect(askPassphrase).not.toHaveBeenCalled();
  });

  it("refuses a wrong passphrase without echoing it or the key", async () => {
    writeKey(nip49.encrypt(secret, PASSPHRASE, 2));
    const message = await failure(() => loadKey(keyPath, pubkey, async () => "not the passphrase"));
    expect(message).toMatch(/passphrase/);
    expect(message).not.toContain("not the passphrase");
    expectNoSecret(message);
  });

  it("names the path and DIVINEBOT_KEY_FILE when the file is missing", async () => {
    const message = await failure(() => loadKey(join(dir, "absent.key"), pubkey, noPassphrase));
    expect(message).toMatch(/DIVINEBOT_KEY_FILE/);
    expect(message).toContain(join(dir, "absent.key"));
  });

  it("refuses content that is neither an nsec nor an ncryptsec, without echoing it", async () => {
    writeKey("hunter2 is my very secret text");
    const message = await failure(() => loadKey(keyPath, pubkey, noPassphrase));
    expect(message).toContain(keyPath);
    expect(message).not.toContain("hunter2");
    expectNoSecret(message);
  });

  it("refuses a raw hex key (only nsec and ncryptsec are accepted), without echoing it", async () => {
    writeKey(hexSecret);
    const message = await failure(() => loadKey(keyPath, pubkey, noPassphrase));
    expectNoSecret(message);
  });

  it("refuses an nsec with a bad checksum without echoing it", async () => {
    const last = nsec.at(-1) === "q" ? "p" : "q";
    const damaged = `${nsec.slice(0, -1)}${last}`;
    writeKey(damaged);
    const message = await failure(() => loadKey(keyPath, pubkey, noPassphrase));
    expect(message).toContain(keyPath);
    expect(message).not.toContain(damaged);
    expect(message).not.toContain(nsec.slice(0, 20));
    expectNoSecret(message);
  });

  describe("refuses an nsec that decodes but is not a usable secret key, without the library's words", () => {
    const cases: [string, Uint8Array][] = [
      ["a 33-byte payload", Uint8Array.from([...secret, 7])],
      ["an all-zero scalar", new Uint8Array(32)],
    ];

    it.each(cases)("%s", async (_name, bytes) => {
      let libraryMessage = "";
      try {
        getPublicKey(bytes);
      } catch (err) {
        libraryMessage = (err as Error).message;
      }
      expect(libraryMessage).not.toBe(""); // the library does refuse it, so loadKey must catch that
      const bad = nip19.encodeBytes("nsec", bytes);
      writeKey(bad);

      const message = await failure(() => loadKey(keyPath, pubkey, noPassphrase));

      expect(message).toBe(`${keyPath} does not hold a valid secret key`);
      expect(message).not.toContain(libraryMessage);
      expect(message).not.toContain(bad);
      expect(message).not.toContain(bytesToHex(bytes));
      expectNoSecret(message);
    });
  });

  it("refuses an npub, which is not a secret key", async () => {
    writeKey(nip19.npubEncode(pubkey));
    const message = await failure(() => loadKey(keyPath, pubkey, noPassphrase));
    expect(message).toContain(keyPath);
  });

  it("refuses a key path that is not a regular file", async () => {
    mkdirSync(join(dir, "adir"));
    chmodSync(join(dir, "adir"), 0o700);
    const message = await failure(() => loadKey(join(dir, "adir"), pubkey, noPassphrase));
    expect(message).toMatch(/regular file/);
  });
});

describe("defaultKeyPath", () => {
  const saved = process.env.DIVINEBOT_KEY_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.DIVINEBOT_KEY_FILE;
    else process.env.DIVINEBOT_KEY_FILE = saved;
  });

  it("is under ~/.config/divine-videos, without reading it", () => {
    delete process.env.DIVINEBOT_KEY_FILE;
    expect(defaultKeyPath()).toBe(join(homedir(), ".config", "divine-videos", "curator.key"));
  });

  it("is overridden by DIVINEBOT_KEY_FILE, and an empty value counts as unset", () => {
    process.env.DIVINEBOT_KEY_FILE = "/somewhere/else.key";
    expect(defaultKeyPath()).toBe("/somewhere/else.key");
    process.env.DIVINEBOT_KEY_FILE = "";
    expect(defaultKeyPath()).toBe(join(homedir(), ".config", "divine-videos", "curator.key"));
  });
});

describe("promptPassphrase", () => {
  it("refuses without a TTY, with a message that holds no secret", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const message = await failure(() => promptPassphrase());
      expect(message).toBe("the key is encrypted and needs a passphrase typed at a terminal: run this command yourself in a terminal");
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});

describe("runDirFor", () => {
  const cfg = { paths: { out: "out-dir" } } as Config;

  it("joins paths.out and a plain run id", () => {
    expect(runDirFor(cfg, "20261005T162233Z-pilot")).toBe(join("out-dir", "20261005T162233Z-pilot"));
  });

  it.each(["", ".", "..", "../x", "a/b", "/abs", ".hidden", "a b", "a\\b"])(
    "refuses %j, which is not a plain directory name",
    (id) => {
      expect(() => runDirFor(cfg, id)).toThrow(/plain directory name/);
    },
  );
});

describe("sign", () => {
  let cfg: Config;
  let runDir: string;

  const item = (d: string): Unsigned => ({
    kind: 39999,
    tags: [["d", d], ["z", cfg.headerCoordinate], ["name", `Place ${d} é "quoted"`], ["t", "cafe"]],
    content: "",
  });
  const deletion: Unsigned = {
    kind: 5,
    tags: [["e", "a".repeat(64)], ["e", "b".repeat(64)], ["a", `39999:${pubkey}:osm-node-1`], ["k", "39999"]],
    content: "",
  };

  const unsignedPath = () => join(runDir, "unsigned.jsonl");
  const signedPath = () => join(runDir, "signed.jsonl");
  const writeUnsigned = (lines: unknown[]) =>
    writeFileSync(unsignedPath(), lines.map((l) => `${typeof l === "string" ? l : JSON.stringify(l)}\n`).join(""));
  const readSigned = () =>
    readFileSync(signedPath(), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Event);

  beforeEach(() => {
    cfg = { ...loadConfig("config.json"), curatorPubkey: pubkey, paths: { out: join(dir, "out"), state: ":memory:" } };
    runDir = join(dir, "out", "run1");
    mkdirSync(runDir, { recursive: true });
    writeManifest(runDir, cfg);
    writeKey(nsec);
  });

  /** A `sign` call that must never reach the key: the path is absent and no passphrase is given. */
  const noKeyOpts = () => ({ keyPath: join(dir, "never-read.key"), askPassphrase: noPassphrase });

  it("writes verifiable events, one per unsigned line, with the tags untouched", async () => {
    const input = [item("osm-node-1"), item("osm-way-2"), deletion];
    writeUnsigned(input);

    const result = await sign(cfg, runDir, { keyPath, now: () => 1_790_000_000 });

    expect(result).toEqual({ signed: 3, pubkey });
    const events = readSigned();
    expect(events).toHaveLength(3);
    events.forEach((event, i) => {
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(pubkey);
      expect(event.created_at).toBe(1_790_000_000);
      expect(event.kind).toBe(input[i]!.kind);
      expect(event.content).toBe("");
      expect(JSON.stringify(event.tags)).toBe(JSON.stringify(input[i]!.tags));
    });
    expect(new Set(events.map((e) => e.id)).size).toBe(3);
  });

  it("never carries a secret into signed.jsonl", async () => {
    writeUnsigned([item("osm-node-1")]);
    await sign(cfg, runDir, { keyPath });
    const text = readFileSync(signedPath(), "utf8");
    expect(text).not.toContain(hexSecret);
    expect(text).not.toContain("nsec1");
  });

  it("stamps the current time when no clock is injected", async () => {
    writeUnsigned([item("osm-node-1")]);
    const before = Math.floor(Date.now() / 1000);
    await sign(cfg, runDir, { keyPath });
    const after = Math.floor(Date.now() / 1000);
    const { created_at } = readSigned()[0]!;
    expect(created_at).toBeGreaterThanOrEqual(before);
    expect(created_at).toBeLessThanOrEqual(after);
  });

  it("leaves no temp file behind", async () => {
    writeUnsigned([item("osm-node-1")]);
    await sign(cfg, runDir, { keyPath });
    expect(readdirSync(runDir).sort()).toEqual(["manifest.json", "signed.jsonl", "unsigned.jsonl"]);
  });

  it("signs with an ncryptsec key and the passphrase it is given", async () => {
    writeKey(nip49.encrypt(secret, PASSPHRASE, 2));
    writeUnsigned([item("osm-node-1")]);
    const result = await sign(cfg, runDir, { keyPath, askPassphrase: async () => PASSPHRASE });
    expect(result.signed).toBe(1);
    expect(verifyEvent(readSigned()[0]!)).toBe(true);
  });

  it("signs an ncryptsec key with a passphrase read by loadPassphraseFile, as --auto does", async () => {
    writeKey(nip49.encrypt(secret, PASSPHRASE, 2));
    const passphrasePath = join(dir, "passphrase");
    writeFileSync(passphrasePath, `${PASSPHRASE}\n`);
    chmodSync(passphrasePath, 0o600);
    writeUnsigned([item("osm-node-1")]);
    const result = await sign(cfg, runDir, { keyPath, askPassphrase: async () => loadPassphraseFile(passphrasePath) });
    expect(result).toEqual({ signed: 1, pubkey });
    expect(verifyEvent(readSigned()[0]!)).toBe(true);
  });

  it.each([0, 39998, 9999])(
    "refuses a run whose unsigned.jsonl mixes a kind %i with items, before loading the key and with nothing written",
    async (kind) => {
      writeUnsigned([item("osm-node-1"), { kind, tags: [["d", "x"]], content: "" }, item("osm-node-2")]);
      const message = await failure(() => sign(cfg, runDir, { keyPath, askPassphrase: noPassphrase }));
      expect(message).toMatch(new RegExp(`line 2: kind ${kind} is not signed here`));
      expect(existsSync(signedPath())).toBe(false);
      expect(vi.mocked(loadKey)).not.toHaveBeenCalled();
    },
  );

  it("zeroes the secret key after signing", async () => {
    writeUnsigned([item("osm-node-1")]);
    await sign(cfg, runDir, { keyPath });
    const key = (await vi.mocked(loadKey).mock.results[0]!.value) as Uint8Array;
    expect(key).toHaveLength(32);
    expect(key.every((b) => b === 0)).toBe(true);
  });

  it("reads the key from DIVINEBOT_KEY_FILE when no keyPath is given, and keyPath wins over it", async () => {
    const saved = process.env.DIVINEBOT_KEY_FILE;
    try {
      writeUnsigned([item("osm-node-1")]);
      process.env.DIVINEBOT_KEY_FILE = keyPath;
      await sign(cfg, runDir);
      expect(existsSync(signedPath())).toBe(true);
      rmSync(signedPath());

      process.env.DIVINEBOT_KEY_FILE = join(dir, "absent.key");
      await sign(cfg, runDir, { keyPath });
      expect(existsSync(signedPath())).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.DIVINEBOT_KEY_FILE;
      else process.env.DIVINEBOT_KEY_FILE = saved;
    }
  });

  it("refuses to overwrite an existing signed.jsonl, before loading the key", async () => {
    writeUnsigned([item("osm-node-1")]);
    writeFileSync(signedPath(), "earlier\n");
    const message = await failure(() => sign(cfg, runDir, noKeyOpts()));
    expect(message).toMatch(/signed\.jsonl already exists/);
    expect(readFileSync(signedPath(), "utf8")).toBe("earlier\n");
    expect(vi.mocked(loadKey)).not.toHaveBeenCalled();
  });

  it("refuses a missing unsigned.jsonl, before loading the key", async () => {
    const message = await failure(() => sign(cfg, runDir, noKeyOpts()));
    expect(message).toContain(unsignedPath());
    expect(message).toMatch(/npm run build/);
    expect(vi.mocked(loadKey)).not.toHaveBeenCalled();
  });

  it.each([["an empty file", ""], ["a file of only a newline", "\n"]])(
    "refuses %s as unsigned.jsonl",
    async (_name, text) => {
      writeFileSync(unsignedPath(), text);
      const message = await failure(() => sign(cfg, runDir, noKeyOpts()));
      expect(message).toMatch(/no events/);
      expect(existsSync(signedPath())).toBe(false);
    },
  );

  it.each([
    ["the header (39998)", 39998],
    ["a note (1)", 1],
    ["a profile (0)", 0],
    ["an unrelated kind (30000)", 30000],
  ])("never signs %s, and writes nothing", async (_name, kind) => {
    writeUnsigned([item("osm-node-1"), { kind, tags: [["d", "x"]], content: "" }]);
    const message = await failure(() => sign(cfg, runDir, noKeyOpts()));
    expect(message).toMatch(/line 2/);
    expect(message).toContain(String(kind));
    expect(existsSync(signedPath())).toBe(false);
    expect(existsSync(`${signedPath()}.tmp`)).toBe(false);
    expect(vi.mocked(loadKey)).not.toHaveBeenCalled();
  });

  it.each([
    ["a line that is not JSON", "{not json", /line 1.*JSON/],
    ["a line that is not an object", "[1,2]", /line 1/],
    ["a kind that is not a number", { kind: "39999", tags: [], content: "" }, /line 1.*kind/],
    ["tags that are not an array", { kind: 39999, tags: "d", content: "" }, /line 1.*tags/],
    ["a tag that is not an array of strings", { kind: 39999, tags: [["d", 1]], content: "" }, /line 1.*tags/],
    ["content that is not a string", { kind: 39999, tags: [], content: 1 }, /line 1.*content/],
    ["a field other than kind, tags and content", { kind: 39999, tags: [], content: "", pubkey }, /line 1.*pubkey/],
    ["a missing field", { kind: 39999, tags: [] }, /line 1.*content/],
  ])("refuses %s, before loading the key", async (_name, line, expected) => {
    writeUnsigned([line]);
    const message = await failure(() => sign(cfg, runDir, noKeyOpts()));
    expect(message).toMatch(expected);
    expect(existsSync(signedPath())).toBe(false);
    expect(vi.mocked(loadKey)).not.toHaveBeenCalled();
  });

  it("writes nothing when the key does not match the config", async () => {
    writeUnsigned([item("osm-node-1")]);
    const other = { ...cfg, curatorPubkey: getPublicKey(generateSecretKey()) };
    writeManifest(runDir, other); // built for that config, so only the key can be wrong
    const message = await failure(() => sign(other, runDir, { keyPath }));
    expect(message).toMatch(/does not match/);
    expectNoSecret(message);
    expect(existsSync(signedPath())).toBe(false);
    expect(existsSync(`${signedPath()}.tmp`)).toBe(false);
  });

  describe("refuses a run built with another config, before loading the key", () => {
    const refused = async (why: RegExp) => {
      writeUnsigned([item("osm-node-1")]);
      const message = await failure(() => sign(cfg, runDir, noKeyOpts()));
      expect(message).toMatch(why);
      expect(existsSync(signedPath())).toBe(false);
      expect(vi.mocked(loadKey)).not.toHaveBeenCalled();
      return message;
    };

    it("a manifest whose curatorPubkey differs, naming the field and both values", async () => {
      writeManifest(runDir, cfg, { curatorPubkey: "c".repeat(64) });
      const message = await refused(/curatorPubkey/);
      expect(message).toContain("c".repeat(64));
      expect(message).toContain(pubkey);
      expect(message).toContain(join(runDir, "manifest.json"));
    });

    it.each([
      ["headerCoordinate", `39998:${"d".repeat(64)}:other-list`],
      ["relays", { dcosl: "ws://127.0.0.1:9" }],
      ["templateIds", { "divine-video": "f".repeat(64), "divine-profile": "f".repeat(64) }],
      ["scope", { includeVines: !loadConfig("config.json").scope.includeVines }],
    ])("a manifest whose %s differs", async (field, value) => {
      writeManifest(runDir, cfg, { [field]: value });
      await refused(new RegExp(`\\b${field}\\b`));
    });

    it("a run with no manifest", async () => {
      rmSync(join(runDir, "manifest.json"));
      await refused(/manifest\.json not found/);
    });

    it("a manifest with no config block", async () => {
      writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ runId: "run1" }));
      await refused(/records no config/);
    });

    it("a manifest that is not JSON", async () => {
      writeFileSync(join(runDir, "manifest.json"), "{nope");
      await refused(/manifest\.json is not valid JSON/);
    });
  });

  it("refuses a clock that does not return whole seconds", async () => {
    writeUnsigned([item("osm-node-1")]);
    const message = await failure(() => sign(cfg, runDir, { keyPath, now: () => 1.5 }));
    expect(message).toMatch(/created_at/);
    expect(existsSync(signedPath())).toBe(false);
  });
});
