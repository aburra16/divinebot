import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { Config } from "../config.js";
import type { State } from "../state.js";
import { classOf, skipReason, slim } from "./classify.js";
import { streamEvents } from "./divine-relay.js";
import { pageOptions, unixNow, VIDEO_KIND, type SourceOptions } from "./sync.js";

export interface SweepResult {
  /** Distinct addresses the sweep read. */
  seen: number;
  /** Addresses newly marked vanished, sorted. */
  vanished: string[];
  /** Events the sweep read that state did not hold, or held an older version of, now stored. */
  upserted: number;
}

/**
 * The Divine relay's limit for one filter's `authors` and for its `#d`. It also takes at most 10
 * filters per REQ; the sweep sends one filter per read, which pages on its own.
 */
const MAX_FILTER_VALUES = 500;

const addressOf = (ev: NostrEvent): string => `${ev.pubkey}:${ev.tags.find((t) => t[0] === "d")?.[1] ?? ""}`;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One filter per group of at most 500 addresses: `authors` and `#d` each hold at most 500
 * values. A filter matches every pairing of its authors and d values, a superset of the group,
 * so the caller checks each event's own address.
 */
export function confirmFilters(addresses: string[]): Filter[] {
  const filters: Filter[] = [];
  for (let i = 0; i < addresses.length; i += MAX_FILTER_VALUES) {
    const group = addresses.slice(i, i + MAX_FILTER_VALUES);
    const authors = new Set<string>();
    const ds = new Set<string>();
    for (const address of group) {
      const at = address.indexOf(":");
      authors.add(address.slice(0, at));
      ds.add(address.slice(at + 1));
    }
    filters.push({ kinds: [VIDEO_KIND], authors: [...authors], "#d": [...ds] });
  }
  return filters;
}

/**
 * Reads the whole native window (`since: harvestSince`) and marks `vanished` every active native
 * video the relay no longer returns. "Seen" is the set of addresses this sweep read, not the
 * stored `lastSeen` (a stale version read again changes no row). Every event read goes through
 * the same classify, slim and upsert path as sync, so a video sync missed (late, backdated or an
 * edit) is stored. Only addresses are kept in memory.
 *
 * Before anything is marked, the read is sanity-checked: it throws, marking nothing and leaving
 * `last_sweep` as it was, when it saw no video at all while state holds active native videos, or
 * when more than `guards.maxVanishedFraction` of the active native videos would vanish. Each
 * address still missing is then asked for by name (`authors` and `#d`, one connection at a time,
 * a page delay apart), and only those the relay still does not return are marked. Nothing is
 * marked, and `last_sweep` is not set, unless every read succeeded.
 */
export async function sweep(cfg: Config, state: State, opts: SourceOptions = {}): Promise<SweepResult> {
  const now = opts.now ?? unixNow;
  const stream = opts.stream ?? streamEvents;
  const sleep = opts.sleep ?? defaultSleep;
  const page = pageOptions(cfg);
  const seen = new Set<string>();
  const startedAt = now();
  let upserted = 0;

  const store = (events: NostrEvent[]) => {
    const addresses = events.map(addressOf);
    state.transaction(() => {
      for (const ev of events) {
        const outcome = state.upsertSource(slim(ev), classOf(ev), skipReason(ev, cfg.scope), startedAt);
        if (outcome === "new" || outcome === "updated") upserted++;
      }
      // An older version read again still counts as seen, and brings a vanished video back.
      state.touchSources(addresses, startedAt);
    });
    for (const address of addresses) seen.add(address);
  };

  const read = await stream(cfg.source.relay, { kinds: [VIDEO_KIND], since: cfg.source.harvestSince }, page, store);
  if (read.stalledAt !== undefined) {
    throw new Error(
      `the relay at ${cfg.source.relay} holds more events at second ${read.stalledAt} than fit in one page, so older videos cannot be checked`,
    );
  }

  const active = state.sourceAddresses({ status: "active", class: "native" });
  const missing = active.filter((address) => !seen.has(address));
  const again = "nothing was marked vanished; run npm run sweep again later";
  if (seen.size === 0 && active.length > 0) {
    throw new Error(
      `the sweep read no videos from ${cfg.source.relay} while state holds ${active.length} active native videos, ` +
        `which points at the relay; ${again}`,
    );
  }
  const limit = cfg.guards.maxVanishedFraction * active.length;
  if (missing.length > limit) {
    throw new Error(
      `the sweep would mark ${missing.length} of ${active.length} active native videos vanished, more than ` +
        `the ${cfg.guards.maxVanishedFraction * 100}% limit (guards.maxVanishedFraction), which points at an incomplete read; ${again}`,
    );
  }

  // Ask for each missing address by name before believing it is gone.
  for (const filter of confirmFilters(missing)) {
    await sleep(page.pageDelayMs);
    const confirm = await stream(cfg.source.relay, filter, page, (events) => store(events.filter((ev) => ev.kind === VIDEO_KIND)));
    if (confirm.stalledAt !== undefined) {
      throw new Error(`the relay at ${cfg.source.relay} could not page through the check of missing videos; ${again}`);
    }
  }
  const vanished = missing.filter((address) => !seen.has(address));

  state.transaction(() => {
    for (const address of vanished) state.setSourceStatus(address, "vanished", startedAt);
    state.setCursor("last_sweep", now());
  });
  return { seen: seen.size, vanished, upserted };
}
