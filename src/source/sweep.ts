import type { Config } from "../config.js";
import type { State } from "../state.js";
import { streamEvents } from "./divine-relay.js";
import { pageOptions, unixNow, VIDEO_KIND, type SourceOptions } from "./sync.js";

export interface SweepResult {
  /** Distinct addresses the sweep read. */
  seen: number;
  /** Addresses newly marked vanished, sorted. */
  vanished: string[];
}

/**
 * Reads the whole native window (`since: harvestSince`) and marks `vanished` every active native
 * video the relay no longer returns. "Seen" is the set of addresses this sweep read, not the
 * stored `lastSeen` (a stale version read again changes no row). Only addresses are kept in
 * memory. Nothing is marked, and `last_sweep` is not set, unless the whole read succeeded.
 */
export async function sweep(cfg: Config, state: State, opts: SourceOptions = {}): Promise<SweepResult> {
  const now = opts.now ?? unixNow;
  const stream = opts.stream ?? streamEvents;
  const seen = new Set<string>();
  const startedAt = now();

  const read = await stream(cfg.source.relay, { kinds: [VIDEO_KIND], since: cfg.source.harvestSince }, pageOptions(cfg), (events) => {
    const addresses = events.map((ev) => `${ev.pubkey}:${ev.tags.find((t) => t[0] === "d")?.[1] ?? ""}`);
    state.touchSources(addresses, startedAt);
    for (const address of addresses) seen.add(address);
  });

  if (read.stalledAt !== undefined) {
    throw new Error(
      `the relay at ${cfg.source.relay} holds more events at second ${read.stalledAt} than fit in one page, so older videos cannot be checked`,
    );
  }
  const vanished = state
    .sourceAddresses({ status: "active", class: "native" })
    .filter((address) => !seen.has(address));
  state.transaction(() => {
    for (const address of vanished) state.setSourceStatus(address, "vanished", startedAt);
    state.setCursor("last_sweep", now());
  });
  return { seen: seen.size, vanished };
}
