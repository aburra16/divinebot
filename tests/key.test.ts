import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultKeyPath, loadKey, loadPassphraseFile, promptPassphrase } from "../src/key.js";

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const hexSecret = bytesToHex(secret);
const nsec = nip19.nsecEncode(secret);
const PASSPHRASE = "correct horse battery staple";

let dir: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divinebot-key-"));
  keyPath = join(dir, "curator.key");
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
      expect(message).toBe("ncryptsec needs an interactive terminal: run npm run sign yourself");
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});

describe("loadPassphraseFile", () => {
  const SECRET_TEXT = "mauve-giraffe-sandwich-4471";
  let passPath: string;

  beforeEach(() => {
    passPath = join(dir, "passphrase");
  });

  it("returns the passphrase at mode 600, without the line break the file ends with", () => {
    writeKey(SECRET_TEXT, 0o600, passPath);
    expect(loadPassphraseFile(passPath)).toBe(SECRET_TEXT);
  });

  it("keeps spaces inside and around the passphrase", () => {
    writeKey(`  ${PASSPHRASE}  `, 0o400, passPath);
    expect(loadPassphraseFile(passPath)).toBe(`  ${PASSPHRASE}  `);
  });

  it.each(["644", "640", "604", "660", "666", "710"])(
    "refuses mode %s, naming the path and suggesting chmod 600, without the file's content",
    (octal) => {
      writeKey(SECRET_TEXT, parseInt(octal, 8), passPath);
      let message = "";
      try {
        loadPassphraseFile(passPath);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/mode/);
      expect(message).toContain(passPath);
      expect(message).toContain("chmod 600");
      expect(message).not.toContain(SECRET_TEXT);
    },
  );

  it("names the path and DIVINEBOT_PASSPHRASE_FILE when the file is missing", () => {
    const missing = join(dir, "absent");
    expect(() => loadPassphraseFile(missing)).toThrow(/DIVINEBOT_PASSPHRASE_FILE/);
    expect(() => loadPassphraseFile(missing)).toThrow(missing);
  });

  it("refuses a path that is not a regular file", () => {
    mkdirSync(join(dir, "adir"));
    chmodSync(join(dir, "adir"), 0o700);
    expect(() => loadPassphraseFile(join(dir, "adir"))).toThrow(/regular file/);
  });

  it("refuses an empty file", () => {
    writeFileSync(passPath, "\n");
    chmodSync(passPath, 0o600);
    expect(() => loadPassphraseFile(passPath)).toThrow(/empty/);
  });

  it("unlocks an ncryptsec through loadKey when handed to it as the passphrase source", async () => {
    writeKey(nip49.encrypt(secret, PASSPHRASE, 2));
    writeKey(PASSPHRASE, 0o600, passPath);
    const key = await loadKey(keyPath, pubkey, async () => loadPassphraseFile(passPath));
    expect(bytesToHex(key)).toBe(hexSecret);
  });
});
