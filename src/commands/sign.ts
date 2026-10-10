import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { Config } from "../config.js";
import type { Unsigned } from "../deletion.js";
import { defaultKeyPath, loadKey, promptPassphrase } from "../key.js";
import { checkRunConfig } from "../manifest.js";

export interface SignOptions {
  /** The key file. Defaults to `$DIVINEBOT_KEY_FILE`, else `~/.config/divine-videos/curator.key`. */
  keyPath?: string;
  /** Called for an ncryptsec only. Defaults to a muted TTY prompt that refuses without a TTY. */
  askPassphrase?: () => Promise<string>;
  /** Unix seconds for `created_at`. Defaults to the wall clock. */
  now?: () => number;
}

/** The only kinds this tool signs: an item (39999) and a NIP-09 deletion (5). Never a 39998. */
const SIGNABLE_KINDS = new Set([39999, 5]);
const FIELDS = ["kind", "tags", "content"];

/** A short rendering of a bad value for an error message. */
function shown(v: unknown): string {
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/** One `unsigned.jsonl` line, held to exactly what `build` writes: `kind`, `tags` and `content`. */
function parseLine(text: string, n: number): Unsigned {
  const bad = (why: string): never => {
    throw new Error(`unsigned.jsonl line ${n}: ${why}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not a JSON object");
  const event = raw as Record<string, unknown>;
  const extra = Object.keys(event).filter((k) => !FIELDS.includes(k));
  if (extra.length > 0) return bad(`unexpected ${extra.length === 1 ? "field" : "fields"} ${extra.join(", ")}`);
  const { kind, tags, content } = event;
  if (typeof kind !== "number") return bad(`kind must be a number, got ${shown(kind)}`);
  if (!SIGNABLE_KINDS.has(kind)) {
    return bad(`kind ${kind} is not signed here; this tool signs only items (39999) and deletions (5)`);
  }
  if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))) {
    return bad("tags must be an array of arrays of strings");
  }
  if (typeof content !== "string") return bad(`content must be a string, got ${shown(content)}`);
  return { kind, tags: tags as string[][], content };
}

/** Reads and checks every line of `path` before anything is signed or any key is loaded. */
function readUnsigned(path: string): Unsigned[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${path} not found; run npm run build first`);
    }
    throw err;
  }
  if (text.trim() === "") throw new Error(`${path} has no events; nothing to sign`);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); // the newline that ends the last line
  return lines.map((line, i) => parseLine(line, i + 1));
}

/**
 * Signs `<runDir>/unsigned.jsonl` into `<runDir>/signed.jsonl` with the curator key, the only
 * place the key is ever loaded.
 *
 * Everything that can be checked without the key is checked first (the run was built with this
 * config, has no signed.jsonl yet, and holds only kind 39999 and 5 lines), so a bad run never
 * asks for a passphrase. The key must derive `cfg.curatorPubkey` (`loadKey` checks). Every event gets one
 * `created_at`, read when signing starts, and the tags exactly as built. The key is zeroed as
 * soon as the last event is signed, and the file appears only whole (temp file, then rename).
 * Returns the pubkey the events were signed with.
 */
export async function sign(
  cfg: Config,
  runDir: string,
  opts: SignOptions = {},
): Promise<{ signed: number; pubkey: string }> {
  checkRunConfig(cfg, runDir);
  const unsignedPath = join(runDir, "unsigned.jsonl");
  const signedPath = join(runDir, "signed.jsonl");
  const refuseOverwrite = (): void => {
    if (existsSync(signedPath)) {
      throw new Error(`${signedPath} already exists; a run is signed once and never overwritten`);
    }
  };
  refuseOverwrite();
  const templates = readUnsigned(unsignedPath);

  const secret = await loadKey(opts.keyPath ?? defaultKeyPath(), cfg.curatorPubkey, opts.askPassphrase ?? promptPassphrase);
  let pubkey: string;
  let lines: string[];
  try {
    pubkey = getPublicKey(secret);
    const createdAt = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
    if (!Number.isInteger(createdAt) || createdAt <= 0) {
      throw new Error(`created_at must be whole Unix seconds, got ${shown(createdAt)}`);
    }
    lines = templates.map((t) => `${JSON.stringify(finalizeEvent({ ...t, created_at: createdAt }, secret))}\n`);
  } finally {
    secret.fill(0);
  }

  refuseOverwrite(); // a passphrase prompt can be long enough for another sign to finish first
  writeFileSync(`${signedPath}.tmp`, lines.join(""));
  renameSync(`${signedPath}.tmp`, signedPath);
  return { signed: lines.length, pubkey };
}
