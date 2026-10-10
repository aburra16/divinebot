import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";
import { getPublicKey } from "nostr-tools/pure";

/*
 * The curator's secret key lives only in the key file and, briefly, in the Uint8Array that
 * `loadKey` returns. No message in this file may contain the key in any form (raw bytes, hex,
 * nsec, ncryptsec) or the passphrase. Error messages are written from scratch for that reason:
 * the libraries' own messages are never passed on, because a bech32 checksum error repeats the
 * string it was given. Nothing here attaches a `cause`, for the same reason.
 */

/** `$DIVINEBOT_KEY_FILE` (an empty value counts as unset), else `~/.config/divine-videos/curator.key`. */
export function defaultKeyPath(): string {
  const override = process.env.DIVINEBOT_KEY_FILE;
  if (override !== undefined && override !== "") return override;
  return join(homedir(), ".config", "divine-videos", "curator.key");
}

/**
 * The text of a secret file, read from one open descriptor whose mode is checked first, so the
 * file that was checked is the file that is read. `what` names the file in messages ("key
 * file", "passphrase file"); `missingHint` says how to point at the right one. Nothing read from
 * the file appears in any message.
 */
function readPrivateFile(path: string, what: string, missingHint: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${what} ${path} not found; ${missingHint}`);
    }
    throw new Error(`cannot open ${what} ${path}: ${(err as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${what} ${path} is not a regular file`);
    if ((stat.mode & 0o077) !== 0) {
      const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
      throw new Error(`${what} ${path} has mode ${mode}, which others can read; run chmod 600 ${path}`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the key file at `path` and returns the 32-byte secret key. The caller zeroes it
 * (`fill(0)`) when done.
 *
 * Refuses, in this order: a file that is missing, not a regular file, or readable by group or
 * others (`mode & 0o077`); content that is not an `nsec1…` or `ncryptsec1…` string once
 * trimmed; a wrong passphrase; a decoded key that is not a valid secret key (wrong length, or a
 * scalar out of range), zeroed before the throw; and a key whose public key is not
 * `expectedPubkey`.
 * `askPassphrase` is called only for an `ncryptsec`.
 *
 * The file is opened once and the mode is read from that descriptor (see `readPrivateFile`).
 */
export async function loadKey(
  path: string,
  expectedPubkey: string,
  askPassphrase: () => Promise<string>,
): Promise<Uint8Array> {
  const text = readPrivateFile(
    path,
    "key file",
    "write your key there, or set DIVINEBOT_KEY_FILE to the file that holds it",
  ).trim();

  const secret = await decodeSecret(path, text, askPassphrase);
  let derived: string;
  try {
    derived = getPublicKey(secret);
  } catch {
    // A payload of the wrong length or a scalar out of range decodes but cannot be a key. The
    // library's message is not passed on (see the note at the top of this file).
    secret.fill(0);
    throw new Error(`${path} does not hold a valid secret key`);
  }
  if (derived !== expectedPubkey) {
    secret.fill(0);
    throw new Error(
      `the key in ${path} does not match the config: it derives pubkey ${derived}, ` +
        `but curatorPubkey is ${expectedPubkey}`,
    );
  }
  return secret;
}

/**
 * The passphrase for an `ncryptsec` key, read from the file at `path` for an unattended run
 * (`DIVINEBOT_PASSPHRASE_FILE`). The same rules as the key file: it must be a regular file that
 * group and others cannot read. Only the line break a text editor adds at the end is removed,
 * because spaces can be part of a passphrase. An empty file is refused. No message here holds
 * any of the file's content.
 */
export function loadPassphraseFile(path: string): string {
  const text = readPrivateFile(
    path,
    "passphrase file",
    "write the passphrase there, or set DIVINEBOT_PASSPHRASE_FILE to the file that holds it",
  ).replace(/\r?\n$/, "");
  if (text === "") throw new Error(`passphrase file ${path} is empty`);
  return text;
}

async function decodeSecret(
  path: string,
  text: string,
  askPassphrase: () => Promise<string>,
): Promise<Uint8Array> {
  if (text.startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(text);
      if (decoded.type === "nsec") return decoded.data;
    } catch {
      // fall through to the message below
    }
    throw new Error(`${path} does not hold a valid secret key (the nsec is damaged)`);
  }
  if (text.startsWith("ncryptsec1")) {
    const passphrase = await askPassphrase();
    try {
      return nip49.decrypt(text, passphrase);
    } catch {
      throw new Error(`could not decrypt ${path}: wrong passphrase, or the ncryptsec is damaged`);
    }
  }
  throw new Error(
    `${path} does not hold a key: expected a Nostr secret key (bech32 "nsec") ` +
      `or an encrypted one (NIP-49 "ncryptsec")`,
  );
}

/**
 * The default passphrase prompt: on stderr, reading from the terminal with echo muted. Without
 * a TTY there is no way to keep the passphrase off the screen and out of a pipe, so it refuses
 * and tells the human to run the command themselves. The message names no command, because
 * `sign` and `profile:publish` both use it. An unattended run never gets here (see `run --auto`).
 */
export function promptPassphrase(): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("the key is encrypted and needs a passphrase typed at a terminal: run this command yourself in a terminal"));
  }
  return new Promise((resolve, reject) => {
    let muted = false;
    // readline echoes what is typed to `output`; this one drops everything once `muted`.
    const output = new Writable({
      write(chunk, encoding, done) {
        if (!muted) process.stderr.write(chunk, encoding);
        done();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    let answered = false;
    rl.on("close", () => {
      if (answered) return;
      process.stderr.write("\n");
      reject(new Error("passphrase entry cancelled"));
    });
    process.stderr.write("ncryptsec passphrase: ");
    muted = true;
    rl.question("", (answer) => {
      answered = true;
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}
