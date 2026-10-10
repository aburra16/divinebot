import { readFileSync } from "node:fs";
import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { Config } from "../config.js";
import { defaultKeyPath, loadKey, promptPassphrase } from "../key.js";
import { connectRelay, newer, publishEvent, query } from "../relay.js";

export interface ProfilePublishOptions {
  /** The key file. Defaults to `$DIVINEBOT_KEY_FILE`, else `~/.config/divine-videos/curator.key`. */
  keyPath?: string;
  /** Called for an ncryptsec only. Defaults to a muted TTY prompt that refuses without a TTY. */
  askPassphrase?: () => Promise<string>;
  /** Unix seconds for `created_at`. Defaults to the wall clock. */
  now?: () => number;
  /**
   * The newest kind 0 the curator has on `relays`, or null when there is none. Defaults to
   * reading every relay and keeping the newest; an unreachable relay is skipped.
   */
  fetchCurrent?: (relays: string[], pubkey: string) => Promise<NostrEvent | null>;
}

/** The only kind this command signs. Items and deletions are signed by `sign`, never here. */
const PROFILE_KIND = 0;

type Fields = Record<string, unknown>;

function isObject(v: unknown): v is Fields {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFilled(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** The fields of `profile.json`, checked before any key is loaded. Refusals are plain sentences. */
function readProfileFile(path: string): Fields {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${path} not found; copy profile.example.json to profile.json and edit it`);
    }
    throw new Error(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!isObject(raw)) throw new Error(`${path} must be a JSON object`);
  if (!isFilled(raw.name)) throw new Error(`${path} needs a name (a non-empty string)`);
  if (!isFilled(raw.about)) throw new Error(`${path} needs an about text (a non-empty string)`);
  if (raw.bot !== true) {
    throw new Error(`${path} must set "bot": true (the boolean, not a string) so the account is marked as automated`);
  }
  return raw;
}

/** The fields of an existing profile's content; anything that is not a JSON object counts as empty. */
function parseContent(ev: NostrEvent | null): Fields {
  if (ev === null) return {};
  try {
    const parsed: unknown = JSON.parse(ev.content);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The newest kind 0 by `pubkey` on any of `relays`, or null when the relays that answered hold
 * none (a fresh account). A relay that cannot be read is skipped, and named on the console when
 * others answered. When none can be read this throws: a kind 0 replaces the whole profile, so
 * publishing without having seen the current one could erase fields set elsewhere.
 */
export function readCurrentProfile(timeoutMs: number) {
  return async (relays: string[], pubkey: string): Promise<NostrEvent | null> => {
    let best: NostrEvent | null = null;
    let answered = 0;
    const skipped: { url: string; reason: string }[] = [];
    await Promise.all(
      relays.map(async (url) => {
        try {
          const relay = await connectRelay(url, timeoutMs);
          try {
            const events = await query(relay, { kinds: [PROFILE_KIND], authors: [pubkey] }, timeoutMs);
            answered++;
            for (const ev of events) {
              if (ev.kind === PROFILE_KIND && ev.pubkey === pubkey) best = newer(ev, best);
            }
          } finally {
            relay.close();
          }
        } catch (err) {
          skipped.push({ url, reason: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    if (answered === 0) {
      throw new Error(
        `No profile relay could be read (${relays.join(", ")}), so nothing was published: ` +
          "publishing now could overwrite profile fields set elsewhere. Try again when a relay answers.",
      );
    }
    for (const { url, reason } of skipped) {
      console.warn(`Could not read the current profile from ${url} (${reason}); using the relays that answered.`);
    }
    return best;
  };
}

/** Sends `ev` to one relay on a connection of its own. Never throws. */
async function sendTo(url: string, ev: NostrEvent, timeoutMs: number): Promise<{ ok: boolean; message: string }> {
  try {
    const relay = await connectRelay(url, timeoutMs);
    try {
      return await publishEvent(relay, ev, timeoutMs);
    } finally {
      relay.close();
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Publishes the curator's kind 0 profile, the only place this tool signs kind 0.
 *
 * `profilePath` is checked first (an object with a non-empty `name` and `about` and `bot: true`),
 * then the key is loaded and must derive `cfg.curatorPubkey`, both before anything touches the
 * network. The current profile must be readable from at least one profile relay (an answer
 * with no kind 0 is fine; no answer at all refuses, as a kind 0 replaces the whole profile). The content is the newest existing profile from `cfg.profileRelays` with every field
 * of `profilePath` laid over it, so fields that only the existing profile has (a picture, say)
 * are kept. The event goes to every profile relay in parallel; one relay failing does not stop
 * the others. The key is zeroed as soon as the event is signed.
 */
export async function profilePublish(
  cfg: Config,
  profilePath: string,
  opts: ProfilePublishOptions = {},
): Promise<{ eventId: string; results: Record<string, { ok: boolean; message: string }> }> {
  const fields = readProfileFile(profilePath);
  const relays = cfg.profileRelays;
  const timeoutMs = cfg.publish.okTimeoutMs;
  const fetchCurrent = opts.fetchCurrent ?? readCurrentProfile(timeoutMs);

  const secret = await loadKey(opts.keyPath ?? defaultKeyPath(), cfg.curatorPubkey, opts.askPassphrase ?? promptPassphrase);
  let ev: NostrEvent;
  try {
    const pubkey = getPublicKey(secret);
    const existing = await fetchCurrent(relays, pubkey);
    const merged = { ...parseContent(existing), ...fields };
    let createdAt = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
    if (!Number.isInteger(createdAt) || createdAt <= 0) {
      throw new Error(`created_at must be whole Unix seconds, got ${String(createdAt)}`);
    }
    // A replaceable event that is not newer than the one it replaces would be ignored.
    if (existing !== null && existing.created_at >= createdAt) createdAt = existing.created_at + 1;
    ev = finalizeEvent({ kind: PROFILE_KIND, created_at: createdAt, tags: [], content: JSON.stringify(merged) }, secret);
  } finally {
    secret.fill(0);
  }

  const entries = await Promise.all(
    relays.map(async (url) => [url, await sendTo(url, ev, timeoutMs)] as const),
  );
  return { eventId: ev.id, results: Object.fromEntries(entries) };
}
