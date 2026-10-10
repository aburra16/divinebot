import type { NostrEvent } from "nostr-tools/core";
import type { Config } from "./config.js";
import { imeta } from "./source/classify.js";
import type { State } from "./state.js";

export type MediaVerdict = {
  url: string;
  status: "pass" | "fail" | "inconclusive";
  httpStatus: number;
  contentType: string;
};

export interface MediaRunResult {
  checked: number;
  passed: number;
  failed: number;
  inconclusive: number;
  /** True when too many checks failed for the failures to be believed; none were stored. */
  outage: boolean;
}

export interface MediaRunOptions {
  /** Seconds since the epoch. */
  now?: () => number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Fewer checks than this say nothing about an outage. */
const OUTAGE_MIN_CHECKS = 20;
const DAY_SECONDS = 86_400;
/** Statuses that mean the file is gone or refused, as opposed to the host having a bad moment. */
const FAIL_STATUSES = new Set([401, 403, 404, 410]);

export function videoUrl(sha256: string, base: string): string {
  return `${base}/${sha256}.mp4`;
}

/**
 * One HEAD request. Only a clear answer from the host counts: 200 with the right type passes; 200
 * with the wrong type, or 401, 403, 404, 410, fails. A timeout, a network error, a 5xx or anything
 * else is inconclusive, because it says nothing about whether the file exists.
 */
export async function checkUrl(
  url: string,
  kind: "video" | "image",
  opts: { timeoutMs: number; fetch?: typeof fetch },
): Promise<MediaVerdict> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch {
    return { url, status: "inconclusive", httpStatus: 0, contentType: "" };
  }
  const contentType = res.headers.get("content-type") ?? "";
  const verdict = (status: MediaVerdict["status"]): MediaVerdict => ({
    url,
    status,
    httpStatus: res.status,
    contentType,
  });
  if (FAIL_STATUSES.has(res.status)) return verdict("fail");
  if (res.status !== 200) return verdict("inconclusive");
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const right = kind === "video" ? type === "video/mp4" : type.startsWith("image/");
  return verdict(right ? "pass" : "fail");
}

function isHttps(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The thumbnail of a source event: its `imeta` `image` exactly as written, when that string starts
 * with `https://`, parses as a URL and has no whitespace around it, else undefined. The one
 * definition of a thumbnail: the media checks check this string, build requires a pass row for
 * this string, and the item writes this string. Nothing is trimmed or normalized (a padded value
 * is no thumbnail), so the three can never disagree and a written thumbnail starts with https://.
 */
export function thumbnailUrl(ev: NostrEvent): string | undefined {
  const image = imeta(ev)?.image;
  return isHttps(image) && image.startsWith("https://") && image === image.trim() ? image : undefined;
}

/**
 * Checks the video and thumbnail of every eligible active source that has no media row, then a
 * rolling slice of the oldest rows (about 1/recheckDays of the live items per run), at most
 * `requestsPerSecond` a second. Inconclusive results are never stored. When more than
 * `guards.maxMediaFailureFraction` of at least 20 checks fail, the host is presumed to be having an
 * outage: the run stores its passes but none of its failures.
 */
export async function runMediaChecks(cfg: Config, state: State, opts: MediaRunOptions = {}): Promise<MediaRunResult> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { media } = cfg;

  const queue = new Map<string, "video" | "image">();
  for (const source of state.sources({ status: "active", eligibleOnly: true })) {
    const meta = imeta(source.event);
    if (!meta) continue;
    if (meta.x) {
      const url = videoUrl(meta.x, media.base);
      if (!queue.has(url) && !state.media(url)) queue.set(url, "video");
    }
    const thumb = thumbnailUrl(source.event);
    if (thumb !== undefined && !queue.has(thumb) && !state.media(thumb)) queue.set(thumb, "image");
  }

  const live = state.counts().live;
  const recheckLimit = live === 0 ? 0 : Math.ceil(live / media.recheckDays);
  if (recheckLimit > 0) {
    for (const url of state.mediaDue(now() - media.recheckDays * DAY_SECONDS, recheckLimit)) {
      if (!queue.has(url)) queue.set(url, url.endsWith(".mp4") ? "video" : "image");
    }
  }

  let checked = 0;
  let passed = 0;
  let inconclusive = 0;
  // Passes are safe whatever the outage verdict, so they are stored as each batch finishes: a crash
  // or SIGINT hours into a first harvest keeps what was done. Failures wait for the verdict.
  let pendingPasses: MediaVerdict[] = [];
  const failures: MediaVerdict[] = [];
  const flushPasses = () => {
    if (pendingPasses.length === 0) return;
    const batch = pendingPasses;
    pendingPasses = [];
    const at = now();
    state.transaction(() => {
      for (const v of batch) state.putMedia(v.url, "pass", v.httpStatus, v.contentType, at);
    });
  };

  try {
    for (const [url, kind] of queue) {
      // A batch of requestsPerSecond, then a full second, keeps any one-second window within the limit.
      if (checked > 0 && checked % media.requestsPerSecond === 0) {
        flushPasses();
        await sleep(1000);
      }
      const v = await checkUrl(url, kind, { timeoutMs: media.timeoutMs, fetch: opts.fetch });
      checked++;
      if (v.status === "pass") {
        passed++;
        pendingPasses.push(v);
      } else if (v.status === "fail") {
        failures.push(v);
      } else {
        inconclusive++;
      }
    }
  } finally {
    flushPasses();
  }

  const failed = failures.length;
  const outage = checked >= OUTAGE_MIN_CHECKS && failed / checked > cfg.guards.maxMediaFailureFraction;
  if (!outage && failures.length > 0) {
    const at = now();
    state.transaction(() => {
      for (const v of failures) state.putMedia(v.url, "fail", v.httpStatus, v.contentType, at);
    });
  }

  return { checked, passed, failed, inconclusive, outage };
}
