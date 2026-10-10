import type { NostrEvent } from "nostr-tools/core";
import { npubEncode } from "nostr-tools/nip19";
import { isHttps, videoUrl } from "./media.js";
import { classOf, imeta, titleOf } from "./source/classify.js";
import { tagValue, type Tags } from "./tags.js";

export interface ItemContext {
  /** The header's `a` coordinate, written once as the `z` tag. */
  headerCoordinate: string;
  mediaBase: string;
  /** Kind 0 display name for a native event. Classic Vines use their `author` tag instead. */
  creator?: string;
  /** A NIP-05 handle that has already been verified against the event's pubkey. */
  nip05?: string;
}

/** The item's `d` tag: `divine-<pubkey>-<source d>`. */
export function itemD(ev: NostrEvent): string {
  return `divine-${ev.pubkey}-${tagValue(ev.tags, "d") ?? ""}`;
}

/** Trimmed text, or undefined when nothing is left. */
function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC `YYYY-MM-DD` for a Unix time in seconds, or undefined when it is not a plain four-digit-year date. */
function utcDate(seconds: number): string | undefined {
  const d = new Date(seconds * 1000);
  if (!Number.isFinite(d.getTime())) return undefined;
  const iso = d.toISOString();
  const date = iso.slice(0, 10);
  return ISO_DATE.test(date) ? date : undefined;
}

function publishedOf(ev: NostrEvent): string | undefined {
  const raw = tagValue(ev.tags, "published_at")?.trim();
  const fromTag = raw && /^\d+$/.test(raw) ? utcDate(Number(raw)) : undefined;
  return fromTag ?? utcDate(ev.created_at);
}

function hashtagsOf(ev: NostrEvent, leading: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of [...leading, ...ev.tags.filter((t) => t[0] === "t").map((t) => t[1] ?? "")]) {
    const tag = name.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * The tags of a kind 39999 item for a source event, in the order of spec § 5. Pure; a field with
 * no value is left out. The event must be eligible: it needs a title, an `imeta` with `x` and a
 * `d` tag, and this throws when it has none.
 */
export function buildItem(ev: NostrEvent, ctx: ItemContext): Tags {
  const cls = classOf(ev);
  const isVine = cls === "vine";
  const meta = imeta(ev);
  const title = titleOf(ev);
  const sourceD = tagValue(ev.tags, "d");
  const sha256 = meta?.x;
  if (!title) throw new Error(`event ${ev.id} has no title`);
  if (!sha256) throw new Error(`event ${ev.id} has no video hash`);
  if (!sourceD) throw new Error(`event ${ev.id} has no d tag`);

  const creator = clean(isVine ? tagValue(ev.tags, "author") : ctx.creator);
  const summary = clean(tagValue(ev.tags, "summary"));
  const image = meta?.image?.trim();
  const language = ev.tags.find((t) => t[0] === "l" && t[2] === "ISO-639-1")?.[1];

  const tags: Tags = [];
  const add = (name: string, value: string | undefined): void => {
    if (value) tags.push([name, value]);
  };

  add("d", itemD(ev));
  add("z", ctx.headerCoordinate);
  add("title", title);
  add("video", videoUrl(sha256, ctx.mediaBase));
  // The same predicate media.ts and build use, so a thumbnail is written only when it was checked.
  add("thumbnail", isHttps(image) ? image : undefined);
  add("creator", creator);
  add("creator-npub", npubEncode(ev.pubkey));
  add("creator-nip05", clean(ctx.nip05));
  add("divine-id", sourceD);
  add("sha256", sha256);
  add("published", publishedOf(ev));
  add("description", summary !== title ? summary : undefined);
  add("duration", clean(meta?.duration) ?? clean(tagValue(ev.tags, "duration")));
  add("dimensions", clean(meta?.dim));
  add("platform", isVine ? "vine" : "divine");
  if (isVine) {
    add("vine-creator-id", clean(tagValue(ev.tags, "vine_user_id")));
    add("vine-loops", clean(tagValue(ev.tags, "loops")));
    add("vine-likes", clean(tagValue(ev.tags, "likes")));
  }
  add("language", clean(language));
  add("verification", clean(tagValue(ev.tags, "verification")));
  add("a", `34236:${ev.pubkey}:${sourceD}`);
  add("p", ev.pubkey);
  for (const t of hashtagsOf(ev, isVine ? ["divine", "vine"] : ["divine"])) add("t", t);
  add("alt", creator ? `Divine video: ${title} by ${creator}` : `Divine video: ${title}`);
  return tags;
}
