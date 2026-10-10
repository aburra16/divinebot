import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { verifyEvent } from "nostr-tools/pure";
import WebSocket from "ws";

/*
 * Paging client for the Divine source relay (Funnelcake). nostr-tools' relay class is not
 * used: `nak req` and library clients hang on this relay while a plain WebSocket works, so
 * this speaks NIP-01 directly. One connection, one REQ per page, each closed at EOSE.
 *
 * Resilience: Divine's relay sometimes resets a long, large stream mid-page. A page that fails
 * because the connection dropped (or was silent, or never opened) is read again on a fresh
 * connection, up to `maxRetries` more times with backoff. `CLOSED` is an explicit refusal and
 * is never retried. Once the budget is spent the read rejects, so nothing is skipped.
 *
 * Memory: a native event averages 22 KB and a first harvest is about 1.1 GB. Only the page in
 * flight is held. It is handed to `onPage` and dropped; across pages only event ids are kept.
 */

export interface PageOptions {
  /** `limit` of each REQ; keep it at or under the relay's own cap so a capped page looks full. */
  pageSize: number;
  /** Pause between one page and the next request. */
  pageDelayMs: number;
  /** Longest the relay may stay silent (connecting, or between messages of a page). */
  readTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts for a page whose connection dropped, went silent or would not open. Default 4. */
  maxRetries?: number;
  /** Told before each retry; `attempt` counts from 1. Default writes a plain line to stderr. */
  onRetry?: (attempt: number, reason: string) => void;
}

/** Waits before retry 1, 2, 3 and 4 of one page; a longer budget reuses the last value. */
const RETRY_BACKOFF_MS = [2000, 5000, 15000, 30000];
const DEFAULT_MAX_RETRIES = 4;

/** A failure of the connection rather than a refusal by the relay, so a retry may succeed. */
class TransientReadError extends Error {}

export interface StreamResult {
  /** REQs answered, counting the last one, which only repeated events already seen. */
  pages: number;
  /** Events handed to `onPage`. */
  events: number;
  /** Events dropped because their signature or shape did not verify. */
  rejected: number;
  /** The created_at that paging could not step past, when a full page brought nothing new. */
  stalledAt?: number;
}

const defaultOnRetry = (attempt: number, why: string) => {
  process.stderr.write(`divine relay: retry ${attempt} of ${DEFAULT_MAX_RETRIES}: ${why}\n`);
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Opens a socket, or rejects with a message naming the relay. */
function connect(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    } catch (err) {
      reject(new TransientReadError(`cannot connect to ${url} (${reason(err)})`));
      return;
    }
    const fail = (err: unknown) => {
      ws.removeAllListeners("open");
      // A socket that fails later must not raise an unhandled 'error'; reads listen for it.
      ws.on("error", () => {});
      reject(new TransientReadError(`cannot connect to ${url} (${reason(err)})`));
    };
    ws.once("open", () => {
      ws.removeListener("error", fail);
      ws.removeListener("close", onClose);
      ws.on("error", () => {});
      resolve(ws);
    });
    const onClose = () => fail(new Error("closed before it opened"));
    ws.once("error", fail);
    ws.once("close", onClose);
  });
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What one REQ brought that earlier pages had not. */
interface PageRead {
  /** New events whose signature verified. */
  events: NostrEvent[];
  /** New events that failed verification or were not shaped like events. */
  rejected: number;
  /** How many events the relay sent in all, repeats included. */
  received: number;
  /** The oldest `created_at` among the new events, forged ones included; undefined if none. */
  oldest?: number;
}

/**
 * One REQ up to EOSE. Events are signature-checked as they arrive; `seen` (ids from every
 * completed page, forged ones too) is extended at EOSE so a repeat is neither delivered nor
 * counted twice. A read that fails leaves `seen` untouched, so retrying the page re-delivers
 * what the failed read had already received. A forged event still moves `oldest`: an honest relay may hold a corrupt event, and
 * leaving it out would make paging repeat the same page and stop short.
 */
function readPage(
  ws: WebSocket,
  url: string,
  subId: string,
  filter: Filter,
  timeoutMs: number,
  seen: Set<string>,
): Promise<PageRead> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new TransientReadError(`${url} dropped the connection before the next page was requested`));
      return;
    }
    const page: PageRead = { events: [], rejected: 0, received: 0 };
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (err?: Error) => {
      clearTimeout(timer);
      ws.removeListener("message", onMessage);
      ws.removeListener("close", onClose);
      ws.removeListener("error", onError);
      if (err === undefined) {
        for (const id of pending) seen.add(id);
        try {
          ws.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          // The page is complete; a failed CLOSE surfaces on the next read.
        }
        resolve(page);
      } else {
        reject(err);
      }
    };
    // Silence, not total time: a page of 5000 native events is over 100 MB (the default is 1000) and may take a while.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => done(new TransientReadError(`${url} did not finish the read within ${timeoutMs / 1000} s`)),
        timeoutMs,
      );
    };
    const onEvent = (ev: unknown) => {
      page.received++;
      const id = isObject(ev) && typeof ev.id === "string" ? ev.id : undefined;
      if (id !== undefined) {
        if (seen.has(id) || pending.has(id)) return;
        pending.add(id);
      }
      const created = isObject(ev) ? ev.created_at : undefined;
      if (typeof created === "number" && Number.isFinite(created)) {
        page.oldest = page.oldest === undefined ? created : Math.min(page.oldest, created);
      }
      let ok = false;
      try {
        ok = verifyEvent(ev as NostrEvent);
      } catch {
        ok = false;
      }
      if (ok) page.events.push(ev as NostrEvent);
      else page.rejected++;
    };
    const onMessage = (data: WebSocket.RawData) => {
      arm();
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!Array.isArray(msg) || msg[1] !== subId) return;
      if (msg[0] === "EVENT") onEvent(msg[2]);
      else if (msg[0] === "EOSE") done();
      else if (msg[0] === "CLOSED") {
        done(new Error(`${url} closed the read before it finished: ${String(msg[2] ?? "")}`));
      }
    };
    const onClose = () => done(new TransientReadError(`${url} dropped the connection during the read`));
    const onError = (err: Error) => done(new TransientReadError(`${url} connection error: ${err.message}`));
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
    arm();
    ws.send(JSON.stringify(["REQ", subId, filter]), (err) => {
      if (err) done(new TransientReadError(`${url} connection error: ${err.message}`));
    });
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Reads every event matching `filter` from the relay at `url`, page by page. Each page asks
 * for events up to the oldest `created_at` seen so far, ties included, so ids are deduplicated
 * and reading stops at the first page that brings nothing new. A full page that brings nothing
 * new means more than a page of events share one `created_at`; the result then carries
 * `stalledAt`. Paging by `until` cannot step past that second.
 *
 * Each page's new, verified events go to `onPage`, which is awaited before the next request.
 * A page lost to a dropped, silent or unopenable connection is read again on a fresh socket,
 * with the same filter and `until`, up to `maxRetries` times (backoff 2, 5, 15, 30 s); `onRetry`
 * hears of each. Rejects, naming the relay, on CLOSED at once, or on a connection failure once
 * the retries are spent; never resolves with a partial read. The socket is closed either way.
 */
export async function streamEvents(
  url: string,
  filter: Filter,
  opts: PageOptions,
  onPage: (events: NostrEvent[]) => void | Promise<void>,
): Promise<StreamResult> {
  const { pageSize, pageDelayMs, readTimeoutMs } = opts;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`pageSize must be a positive integer, got ${pageSize}`);
  }
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`maxRetries must be a non-negative integer, got ${maxRetries}`);
  }
  const sleep = opts.sleep ?? defaultSleep;
  const onRetry = opts.onRetry ?? defaultOnRetry;
  let ws: WebSocket | undefined;
  const closeSocket = () => {
    if (ws === undefined) return;
    ws.removeAllListeners("message");
    ws.close();
    ws = undefined;
  };
  /** One page on the current connection, opening one first when there is none. */
  const attempt = async (subId: string, request: Filter, seen: Set<string>): Promise<PageRead> => {
    ws ??= await connect(url, readTimeoutMs);
    return readPage(ws, url, subId, request, readTimeoutMs, seen);
  };
  try {
    const seen = new Set<string>();
    const result: StreamResult = { pages: 0, events: 0, rejected: 0 };
    let until = filter.until;
    for (;;) {
      if (result.pages > 0) await sleep(pageDelayMs);
      const subId = `divine-${result.pages + 1}`;
      const request: Filter = { ...filter, ...(until === undefined ? {} : { until }), limit: pageSize };
      let page: PageRead;
      for (let tries = 0; ; tries++) {
        try {
          page = await attempt(subId, request, seen);
          break;
        } catch (err) {
          closeSocket();
          if (!(err instanceof TransientReadError) || tries >= maxRetries) throw err;
          onRetry(tries + 1, reason(err));
          await sleep(RETRY_BACKOFF_MS[Math.min(tries, RETRY_BACKOFF_MS.length - 1)]!);
        }
      }
      result.pages++;
      result.rejected += page.rejected;
      const fresh = page.events.length + page.rejected;
      if (fresh === 0) {
        if (page.received >= pageSize && until !== undefined) result.stalledAt = until;
        return result;
      }
      if (page.oldest !== undefined) until = until === undefined ? page.oldest : Math.min(until, page.oldest);
      result.events += page.events.length;
      if (page.events.length > 0) await onPage(page.events);
    }
  } finally {
    closeSocket();
  }
}
