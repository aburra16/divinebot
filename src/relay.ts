import { AbstractRelay } from "nostr-tools/abstract-relay";
import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { verifyEvent } from "nostr-tools/pure";

/** How long a read waits for a connection, and then for each page's EOSE. */
export const DEFAULT_READ_TIMEOUT_MS = 10_000;
/** strfry's default `maxFilterLimit`; a page larger than a relay's cap would hide a stall. */
const DEFAULT_PAGE_SIZE = 500;
/** The largest page asked for, whatever a relay advertises (dcosl advertises 10000). */
const MAX_PAGE_SIZE = 10_000;
/** How long the NIP-11 read may take before the default page size is used. */
const INFO_TIMEOUT_MS = 3_000;

/**
 * Node's built-in WebSocket dispatches `error` again from inside `close()` while it is still
 * connecting, and nostr-tools calls `close()` from its `onerror`. Together they recurse until
 * the stack overflows whenever a relay is unreachable. A re-entrant `close()` is ignored here,
 * which breaks the loop; the first call still closes the socket.
 */
class GuardedWebSocket extends WebSocket {
  #closing = false;

  override close(code?: number, reason?: string): void {
    if (this.#closing) return;
    this.#closing = true;
    super.close(code, reason);
  }
}

/** Connects to a relay that verifies event signatures, or throws a plain error naming it. */
export async function connectRelay(url: string, timeoutMs: number): Promise<AbstractRelay> {
  const relay = new AbstractRelay(url, { verifyEvent, websocketImplementation: GuardedWebSocket });
  try {
    await relay.connect({ timeout: timeoutMs });
  } catch (err) {
    relay.close();
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot connect to ${url} (${reason})`);
  }
  return relay;
}

/** `filter` with the NIP-50 `search` field set to `search`; `filter` itself when there is none. */
export function withSearch(filter: Filter, search: string | undefined): Filter {
  return search === undefined ? filter : { ...filter, search };
}

/** Of two versions of a replaceable event, the newer; on a tie, the lower id (NIP-01). */
export function newer(a: NostrEvent, b: NostrEvent | null): NostrEvent {
  if (b === null || a.created_at > b.created_at) return a;
  if (a.created_at === b.created_at && a.id < b.id) return a;
  return b;
}

/**
 * Sends `ev` on a connected relay and waits up to `timeoutMs` for its `OK`. Never throws: a
 * rejection, a timeout or a closed connection comes back as `ok: false` with the reason, so
 * the caller can record it like any other result.
 */
export async function publishEvent(
  relay: AbstractRelay,
  ev: NostrEvent,
  timeoutMs: number,
): Promise<{ ok: boolean; message: string }> {
  if (!relay.connected) return { ok: false, message: `not connected to ${relay.url}` };
  // Read once, synchronously, when publish() arms its timer for this event.
  relay.publishTimeout = timeoutMs;
  try {
    const message: unknown = await relay.publish(ev);
    return { ok: true, message: typeof message === "string" ? message : "" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One REQ on a connected relay: every event it sends before EOSE. Rejects if the relay closes
 * the subscription first or does not reach EOSE within `timeoutMs`, so a slow relay is never
 * read as an empty one.
 */
export function query(relay: AbstractRelay, filter: Filter, timeoutMs: number): Promise<NostrEvent[]> {
  if (!relay.connected) return Promise.reject(new Error(`not connected to ${relay.url}`));
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    let settled = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err === undefined) resolve(events);
      else reject(err);
    };
    const sub = relay.subscribe([filter], {
      // Longer than our own timer, so the library never reports a silent relay as EOSE.
      eoseTimeout: timeoutMs + 5_000,
      onevent: (ev) => {
        events.push(ev);
      },
      oneose: () => {
        finish();
        if (!closed) sub.close();
      },
      onclose: (reason) => {
        closed = true;
        finish(new Error(`${relay.url} closed the read before it finished: ${reason}`));
        // Stops the library's own EOSE timer, which would otherwise hold the process open.
        sub.receivedEose();
      },
    });
    if (settled) return;
    timer = setTimeout(() => {
      finish(new Error(`${relay.url} did not finish the read within ${timeoutMs / 1000} s`));
      sub.close();
    }, timeoutMs);
  });
}

/** What paging found, and the `created_at` it could not step past, if it stalled. */
export interface Paged {
  events: NostrEvent[];
  stalledAt?: number;
}

/**
 * Every event matching `filter` on a connected relay, read in pages of `pageSize`. Each page
 * asks for events up to the oldest `created_at` seen so far, ties included, and ids are
 * deduplicated; reading stops at the first page that brings no new event.
 *
 * Paging by `until` cannot step past a single `created_at` that more than a page of events
 * share: the relay keeps returning the same page. When that happens (a full page, nothing
 * new) the result carries `stalledAt` and holds only what was seen. `pageSize` should not
 * exceed the relay's own limit cap, or a capped page would not look full.
 */
export async function queryPaged(
  relay: AbstractRelay,
  filter: Filter,
  pageSize: number,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
): Promise<Paged> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`pageSize must be a positive integer, got ${pageSize}`);
  }
  const seen = new Map<string, NostrEvent>();
  let until = filter.until;
  for (;;) {
    const page = await query(
      relay,
      { ...filter, ...(until === undefined ? {} : { until }), limit: pageSize },
      timeoutMs,
    );
    let added = 0;
    for (const ev of page) {
      if (seen.has(ev.id)) continue;
      seen.set(ev.id, ev);
      added++;
      until = until === undefined ? ev.created_at : Math.min(until, ev.created_at);
    }
    if (added > 0) continue;
    const events = [...seen.values()];
    return page.length >= pageSize ? { events, stalledAt: until } : { events };
  }
}

/**
 * Every event on the relay at `url` that matches `filter` (see queryPaged), on a connection of
 * its own that is closed before returning. Throws rather than return a list that silently
 * misses events when paging stalls.
 */
export async function queryAll(
  url: string,
  filter: Filter,
  pageSize = DEFAULT_PAGE_SIZE,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
): Promise<NostrEvent[]> {
  const relay = await connectRelay(url, timeoutMs);
  try {
    const { events, stalledAt } = await queryPaged(relay, filter, pageSize, timeoutMs);
    if (stalledAt !== undefined) {
      throw new Error(
        `${url}: more than ${pageSize} events share created_at ${stalledAt}, so paging by until ` +
          "cannot list them all",
      );
    }
    return events;
  } finally {
    relay.close();
  }
}

/** The NIP-11 address of a relay: its URL with wss as https and ws as http. */
export function relayInfoUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
}

/** The relay's NIP-11 information document. Rejects on a network or HTTP error or a timeout. */
export async function fetchRelayInfo(wsUrl: string, timeoutMs = INFO_TIMEOUT_MS): Promise<unknown> {
  const url = relayInfoUrl(wsUrl);
  const res = await fetch(url, {
    headers: { Accept: "application/nostr+json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered NIP-11 with HTTP ${res.status}`);
  return res.json();
}

/**
 * The page size to read the relay with: its NIP-11 `limitation.max_limit`, capped at
 * MAX_PAGE_SIZE. When the document cannot be read or has no positive whole max_limit, the
 * fallback is strfry's default cap.
 */
export async function relayPageSize(
  wsUrl: string,
  fetchInfo: (wsUrl: string) => Promise<unknown> = fetchRelayInfo,
): Promise<number> {
  let info: unknown;
  try {
    info = await fetchInfo(wsUrl);
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
  const max = (info as { limitation?: { max_limit?: unknown } } | null)?.limitation?.max_limit;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(max, MAX_PAGE_SIZE);
}
