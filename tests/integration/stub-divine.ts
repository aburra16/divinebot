import type { NostrEvent } from "nostr-tools/core";
import { startStubRelay } from "../stub-relay.js";

export interface StubDivine {
  url: string;
  /** Every filter the stub was asked for, in arrival order. */
  requests: Record<string, unknown>[];
  /** Stores `ev`. A replaceable or addressable event replaces its older version, as a relay does. */
  add(ev: NostrEvent): void;
  /** Drops the event with this id, as a relay that lost a video does. */
  remove(id: string): void;
  close(): Promise<void>;
}

const isReplaceable = (kind: number) => kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000);
const isAddressable = (kind: number) => kind >= 30_000 && kind < 40_000;
const dOf = (ev: NostrEvent) => ev.tags.find((t) => t[0] === "d")?.[1] ?? "";

/** True when `ev` meets every condition of the NIP-01 `filter` the stub honours. */
function matches(ev: NostrEvent, filter: Record<string, unknown>): boolean {
  const list = (key: string): unknown[] | undefined => (Array.isArray(filter[key]) ? (filter[key] as unknown[]) : undefined);
  if (list("ids") && !list("ids")!.includes(ev.id)) return false;
  if (list("kinds") && !list("kinds")!.includes(ev.kind)) return false;
  if (list("authors") && !list("authors")!.includes(ev.pubkey)) return false;
  if (typeof filter.since === "number" && ev.created_at < filter.since) return false;
  if (typeof filter.until === "number" && ev.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!ev.tags.some((t) => t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}

/**
 * A stand-in for the Divine relay on loopback: it holds `events` and answers a REQ with the
 * events that match, newest first (ties by id), cut at `limit`, then EOSE. It honours `ids`,
 * `kinds`, `authors`, `since`, `until`, `limit` and any `#x` tag filter, which covers `#k` and
 * `#d`. It accepts no writes.
 */
export async function startStubDivine(events: NostrEvent[]): Promise<StubDivine> {
  const store = new Map<string, NostrEvent>();
  const requests: Record<string, unknown>[] = [];

  const add = (ev: NostrEvent): void => {
    if (isReplaceable(ev.kind) || isAddressable(ev.kind)) {
      for (const held of [...store.values()]) {
        const same =
          held.kind === ev.kind && held.pubkey === ev.pubkey && (isReplaceable(ev.kind) || dOf(held) === dOf(ev));
        if (!same) continue;
        if (held.created_at > ev.created_at) return; // the stub already holds a newer version
        store.delete(held.id);
      }
    }
    store.set(ev.id, ev);
  };
  for (const ev of events) add(ev);

  const relay = await startStubRelay(
    () => {},
    (filters, ctx) => {
      const out = new Map<string, NostrEvent>();
      for (const filter of filters) {
        requests.push(filter);
        const found = [...store.values()]
          .filter((ev) => matches(ev, filter))
          .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
        const limit = typeof filter.limit === "number" ? filter.limit : found.length;
        for (const ev of found.slice(0, limit)) out.set(ev.id, ev);
      }
      for (const ev of out.values()) ctx.send(ev);
      ctx.eose();
    },
  );

  return {
    url: relay.url,
    requests,
    add,
    remove: (id) => {
      store.delete(id);
    },
    close: () => relay.close(),
  };
}
