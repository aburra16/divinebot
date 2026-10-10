import type { NostrEvent } from "nostr-tools/core";
import { readSearch, relayUrl, type Config } from "../config.js";
import { checkHeader, fetchHeader } from "../header.js";
import { connectRelay, publishEvent, query, withSearch } from "../relay.js";

const TEMPLATE_KIND = 9999;

/** Both templates by id from the relay at `url`; throws, naming any it does not hold. */
async function fetchTemplates(url: string, ids: string[], search: string | undefined, timeoutMs: number): Promise<NostrEvent[]> {
  let found: NostrEvent[];
  try {
    const relay = await connectRelay(url, timeoutMs);
    try {
      found = await query(relay, withSearch({ ids, kinds: [TEMPLATE_KIND] }, search), timeoutMs);
    } finally {
      relay.close();
    }
  } catch (err) {
    throw new Error(`cannot read the templates: ${err instanceof Error ? err.message : String(err)}`);
  }
  return ids.map((id) => {
    const ev = found.find((e) => e.id === id && e.kind === TEMPLATE_KIND);
    if (ev === undefined) throw new Error(`template ${id} not found on ${url}`);
    return ev;
  });
}

/**
 * Copies the header and both templates from `headerRelay` to the relay called `toRelay`: the
 * exact events read back (signatures checked on the way in), never re-signed, so the copies
 * have the same ids and sigs. The header must pass checkHeader and all three events must be
 * read before anything is published. Returns the target's answer for each event.
 */
export async function rebroadcast(
  cfg: Config,
  toRelay = "search",
): Promise<{ eventId: string; ok: boolean; message: string }[]> {
  const target = relayUrl(cfg, toRelay);
  if (toRelay === cfg.headerRelay) {
    throw new Error(`${toRelay} is the header relay: the events are read from there, so there is nothing to copy`);
  }
  const source = relayUrl(cfg, cfg.headerRelay);
  const search = readSearch(cfg, cfg.headerRelay);
  const header = await fetchHeader(source, cfg.headerCoordinate, undefined, search);
  checkHeader(header, cfg);
  const templates = await fetchTemplates(
    source,
    [cfg.templateIds["divine-video"], cfg.templateIds["divine-profile"]],
    search,
    cfg.publish.okTimeoutMs,
  );

  const relay = await connectRelay(target, cfg.publish.okTimeoutMs);
  try {
    const results: { eventId: string; ok: boolean; message: string }[] = [];
    for (const ev of [header, ...templates]) {
      results.push({ eventId: ev.id, ...(await publishEvent(relay, ev, cfg.publish.okTimeoutMs)) });
    }
    return results;
  } finally {
    relay.close();
  }
}
