import type { NostrEvent } from "nostr-tools/core";
import type { Config } from "../config.js";
import type { State } from "../state.js";
import { classOf, skipReason, slim } from "./classify.js";
import { streamEvents, type PageOptions } from "./divine-relay.js";

export const VIDEO_KIND = 34236;
const DELETION_KIND = 5;

export interface SyncResult {
  videos: { new: number; updated: number; same: number; older: number; rejected: number };
  /** `applied`: kind 5 events that deleted a stored video. `ignored`: every other one. */
  deletions: { applied: number; ignored: number };
  /** True when there was no videos cursor, so the read started at `source.harvestSince`. */
  firstHarvest: boolean;
}

export interface SourceOptions {
  /** Unix seconds. */
  now?: () => number;
  stream?: typeof streamEvents;
}

export const unixNow = (): number => Math.floor(Date.now() / 1000);

export function pageOptions(cfg: Config): PageOptions {
  const { pageSize, pageDelayMs, readTimeoutMs } = cfg.source;
  return { pageSize, pageDelayMs, readTimeoutMs };
}

/** Where a read of a cursor-tracked window starts: the cursor minus the overlap, or the harvest start. */
function windowStart(cfg: Config, cursor: number | undefined): number {
  return cursor === undefined ? cfg.source.harvestSince : cursor - cfg.source.overlapSeconds;
}

/**
 * Applies one kind 5 event and says whether it deleted a stored video. The video is found by the
 * `a` tags (`34236:<pubkey>:<d>`, the pubkey being the deleter's own). It is deleted when the
 * deletion also names the stored event by an `e` tag, or when it is no older than the stored
 * version (NIP-09: an `a` deletion covers versions up to its own `created_at`, so a deletion read
 * again in the overlap must not remove a later republish). State keeps one version per video, so
 * an `e` naming an earlier version does not match.
 */
function applyDeletion(state: State, del: NostrEvent, at: number): boolean {
  let applied = false;
  const prefix = `${VIDEO_KIND}:${del.pubkey}:`;
  for (const tag of del.tags) {
    if (tag[0] !== "a" || !tag[1]?.startsWith(prefix)) continue;
    const address = `${del.pubkey}:${tag[1].slice(prefix.length)}`;
    const row = state.source(address);
    if (!row || row.status === "deleted" || row.event.pubkey !== del.pubkey) continue;
    const namesStoredEvent = del.tags.some((t) => t[0] === "e" && t[1] === row.eventId);
    if (!namesStoredEvent && del.created_at < row.createdAt) continue;
    state.setSourceStatus(address, "deleted", at);
    applied = true;
  }
  return applied;
}

/**
 * Reads new and edited videos, then author deletions, from the Divine relay, one page at a time.
 * Each page is classified, slimmed and written in one transaction. A cursor moves to the newest
 * `created_at` read only after its stream resolves: a relay that drops mid-read leaves the
 * cursor where it was, and the next run reads the gap again (the writes are idempotent).
 */
export async function sync(cfg: Config, state: State, opts: SourceOptions = {}): Promise<SyncResult> {
  const now = opts.now ?? unixNow;
  const stream = opts.stream ?? streamEvents;
  const page = pageOptions(cfg);
  const result: SyncResult = {
    videos: { new: 0, updated: 0, same: 0, older: 0, rejected: 0 },
    deletions: { applied: 0, ignored: 0 },
    firstHarvest: false,
  };

  const videosCursor = state.cursor("videos");
  result.firstHarvest = videosCursor === undefined;
  let newestVideo: number | undefined;
  const read = await stream(
    cfg.source.relay,
    { kinds: [VIDEO_KIND], since: windowStart(cfg, videosCursor) },
    page,
    (events) => {
      const seenAt = now();
      state.transaction(() => {
        for (const ev of events) {
          const outcome = state.upsertSource(slim(ev), classOf(ev), skipReason(ev, cfg.scope), seenAt);
          result.videos[outcome]++;
        }
      });
      for (const ev of events) newestVideo = Math.max(newestVideo ?? ev.created_at, ev.created_at);
    },
  );
  result.videos.rejected = read.rejected;
  if (newestVideo !== undefined) state.setCursor("videos", Math.max(newestVideo, videosCursor ?? newestVideo));

  const deletionsCursor = state.cursor("deletions");
  let newestDeletion: number | undefined;
  await stream(
    cfg.source.relay,
    { kinds: [DELETION_KIND], "#k": [String(VIDEO_KIND)], since: windowStart(cfg, deletionsCursor) },
    page,
    (events) => {
      const at = now();
      state.transaction(() => {
        for (const ev of events) {
          if (applyDeletion(state, ev, at)) result.deletions.applied++;
          else result.deletions.ignored++;
        }
      });
      for (const ev of events) newestDeletion = Math.max(newestDeletion ?? ev.created_at, ev.created_at);
    },
  );
  if (newestDeletion !== undefined) {
    state.setCursor("deletions", Math.max(newestDeletion, deletionsCursor ?? newestDeletion));
  }
  return result;
}
