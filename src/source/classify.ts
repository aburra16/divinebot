import type { NostrEvent } from "nostr-tools/core";
import type { Config } from "../config.js";
import type { SourceClass } from "../state.js";

export type SkipReason =
  | "classic-vine"
  | "user-submitted"
  | "no-d"
  | "bad-d"
  | "no-imeta"
  | "bad-sha256"
  | "not-mp4"
  | "no-title"
  | "content-warning"
  | "expiration";

/** Tags that carry no item data and make up most of a native event's size. */
const HEAVY_TAGS = new Set(["proofmode", "device_attestation", "c2pa_manifest_id"]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A control character (Unicode category Cc) or a line or paragraph separator. A `d` holding one
 * would put a line break or an invisible character into the item's `d`, `divine-id` and `a`.
 */
const BAD_D_CHAR = /[\p{Cc}\u2028\u2029]/u;

function hasTag(ev: NostrEvent, name: string, value?: string): boolean {
  return ev.tags.some((t) => t[0] === name && (value === undefined || t[1] === value));
}

/** Native, classic Vine archive, or user-submitted archive (user-submitted wins over vine). */
export function classOf(ev: NostrEvent): SourceClass {
  if (hasTag(ev, "l", "user-submitted")) return "user-submitted";
  if (hasTag(ev, "l", "vine-archive") || hasTag(ev, "platform", "vine")) return "vine";
  return "native";
}

/** The first `imeta` tag as a key/value record. Each entry splits at its first space. */
export function imeta(ev: NostrEvent): Record<string, string> | undefined {
  const tag = ev.tags.find((t) => t[0] === "imeta");
  if (!tag) return undefined;
  const out: Record<string, string> = {};
  for (const entry of tag.slice(1)) {
    const i = entry.indexOf(" ");
    if (i <= 0) continue;
    const key = entry.slice(0, i);
    if (!(key in out)) out[key] = entry.slice(i + 1);
  }
  return out;
}

/** `title`, else the first non-empty line of `summary`; trimmed. */
export function titleOf(ev: NostrEvent): string | undefined {
  const title = ev.tags.find((t) => t[0] === "title")?.[1]?.trim();
  if (title) return title;
  const summary = ev.tags.find((t) => t[0] === "summary")?.[1];
  if (summary) {
    for (const line of summary.split(/\r?\n/)) {
      const l = line.trim();
      if (l) return l;
    }
  }
  return undefined;
}

/**
 * Spec § 4 rules 2 to 6, in order. Rule 1 (signature) and rule 7 (media) live elsewhere. Right
 * after scope, a video needs a usable `d`: the item's `d`, `divine-id` and `a` are built from it.
 */
export function skipReason(ev: NostrEvent, scope: Config["scope"]): SkipReason | null {
  if (!scope.includeVines) {
    const cls = classOf(ev);
    if (cls === "vine") return "classic-vine";
    if (cls === "user-submitted") return "user-submitted";
  }
  const d = ev.tags.find((t) => t[0] === "d")?.[1];
  if (!d?.trim()) return "no-d";
  if (BAD_D_CHAR.test(d)) return "bad-d";
  const meta = imeta(ev);
  if (!meta) return "no-imeta";
  if (!SHA256_HEX.test(meta.x ?? "")) return "bad-sha256";
  if (meta.m !== "video/mp4") return "not-mp4";
  if (!titleOf(ev)) return "no-title";
  if (
    hasTag(ev, "content-warning") ||
    ev.tags.some((t) => t[0] === "l" && t[2] === "content-warning") ||
    hasTag(ev, "L", "content-warning")
  ) {
    return "content-warning";
  }
  if (hasTag(ev, "expiration")) return "expiration";
  return null;
}

/**
 * Drop the heavy attestation tags before storing. Runs after the signature check, so the stored
 * event no longer verifies; state treats it as verified on read.
 */
export function slim(ev: NostrEvent): NostrEvent {
  return { ...ev, tags: ev.tags.filter((t) => !HEAVY_TAGS.has(t[0] ?? "")).map((t) => [...t]) };
}
