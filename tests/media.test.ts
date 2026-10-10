import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools/core";
import { loadConfig, type Config } from "../src/config.js";
import { checkUrl, runMediaChecks, thumbnailUrl, videoUrl } from "../src/media.js";
import { openState, type State } from "../src/state.js";

const cfg: Config = loadConfig(new URL("../config.json", import.meta.url).pathname);
const NOW = 1_800_000_000;
const DAY = 86_400;
const PK = "a".repeat(64);

const hex = (i: number) => i.toString(16).padStart(64, "0");

function source(i: number, opts: { image?: string | null; x?: string } = {}): NostrEvent {
  const x = opts.x ?? hex(i);
  const image = opts.image === undefined ? `https://media.divine.video/thumb-${i}` : opts.image;
  const imetaTag = ["imeta", `url https://media.divine.video/${x}`, "m video/mp4", `x ${x}`];
  if (image !== null) imetaTag.push(`image ${image}`);
  return {
    id: hex(1000 + i),
    pubkey: PK,
    created_at: 1_700_000_000 + i,
    kind: 34236,
    tags: [["d", `v${i}`], ["title", `Video ${i}`], imetaTag],
    content: "",
    sig: "0".repeat(128),
  };
}

const addSource = (state: State, ev: NostrEvent, skip: string | null = null) =>
  state.upsertSource(ev, "native", skip, NOW);

const vurl = (i: number) => videoUrl(hex(i), cfg.media.base);
const turl = (i: number) => `https://media.divine.video/thumb-${i}`;

function res(status: number, contentType?: string): Response {
  return new Response(null, { status, headers: contentType ? { "content-type": contentType } : {} });
}

type Reply = Response | Error;
/** A fetch that answers per URL with `answer`, and records each call. */
function fakeFetch(answer: (url: string) => Reply) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = answer(url);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { f, calls };
}

const ok = (url: string): Reply => (url.endsWith(".mp4") ? res(200, "video/mp4") : res(200, "image/jpeg"));

const noSleep = async () => {};

let state: State;
beforeEach(() => {
  state = openState(":memory:");
});

describe("videoUrl", () => {
  it("builds the .mp4 URL the example items use", () => {
    const items = readFileSync(new URL("../header/example-items.json", import.meta.url), "utf8");
    const sha = "ad9cd0843e7b4e4646009964e7a50e167484d1ef5a8cc48484628f87926b6553";
    const url = videoUrl(sha, "https://media.divine.video");
    expect(url).toBe(`https://media.divine.video/${sha}.mp4`);
    expect(items).toContain(url);
  });
});

describe("thumbnailUrl", () => {
  it("returns imeta image exactly as written when it parses as https and has no surrounding whitespace, else undefined", () => {
    expect(thumbnailUrl(source(1))).toBe(turl(1));
    expect(thumbnailUrl(source(1, { image: null }))).toBeUndefined();
    for (const bad of ["http://x.test/a.jpg", "https://", "https://exa mple.com/a.jpg", "\u00a0https://x.test/a.jpg", "\ufeffhttps://x.test/a.jpg"]) {
      expect(thumbnailUrl(source(1, { image: bad }))).toBeUndefined();
    }
    for (const padded of ["  https://x.test/a.jpg  ", " https://x.test/a.jpg", "https://x.test/a.jpg ", "https://x.test/a.jpg\t"]) {
      expect(thumbnailUrl(source(1, { image: padded })), JSON.stringify(padded)).toBeUndefined();
    }
  });
});

describe("checkUrl", () => {
  it("passes a 200 video/mp4 for a video", async () => {
    const { f, calls } = fakeFetch(() => res(200, "video/mp4"));
    const v = await checkUrl("https://m/x.mp4", "video", { timeoutMs: 1000, fetch: f });
    expect(v).toEqual({ url: "https://m/x.mp4", status: "pass", httpStatus: 200, contentType: "video/mp4" });
    expect(calls[0]?.init?.method).toBe("HEAD");
    expect(calls[0]?.init?.redirect).toBe("follow");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes a 200 image/* for an image", async () => {
    const { f } = fakeFetch(() => res(200, "image/webp"));
    expect((await checkUrl("https://m/t", "image", { timeoutMs: 1000, fetch: f })).status).toBe("pass");
  });

  it("fails a 200 with the wrong content type", async () => {
    const { f } = fakeFetch(() => res(200, "text/html; charset=utf-8"));
    const v = await checkUrl("https://m/x.mp4", "video", { timeoutMs: 1000, fetch: f });
    expect(v.status).toBe("fail");
    expect(v.contentType).toBe("text/html; charset=utf-8");
  });

  it("fails a 200 with no content type", async () => {
    const { f } = fakeFetch(() => res(200));
    expect((await checkUrl("https://m/x.mp4", "video", { timeoutMs: 1000, fetch: f })).status).toBe("fail");
  });

  it("accepts a video/mp4 type with parameters or other case", async () => {
    const { f } = fakeFetch(() => res(200, "Video/MP4; codecs=avc1"));
    expect((await checkUrl("https://m/x.mp4", "video", { timeoutMs: 1000, fetch: f })).status).toBe("pass");
  });

  it.each([401, 403, 404, 410])("fails a %i", async (code) => {
    const { f } = fakeFetch(() => res(code, "text/plain"));
    const v = await checkUrl("https://m/x.mp4", "video", { timeoutMs: 1000, fetch: f });
    expect(v.status).toBe("fail");
    expect(v.httpStatus).toBe(code);
  });

  it.each([500, 502, 503, 429, 301, 204])("is inconclusive on a %i", async (code) => {
    const { f } = fakeFetch(() => res(code));
    expect((await checkUrl("https://m/x.mp4", "video", { timeoutMs: 1000, fetch: f })).status).toBe("inconclusive");
  });

  it("is inconclusive on an abort or a network error", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    for (const err of [abort, new TypeError("fetch failed")]) {
      const { f } = fakeFetch(() => err);
      const v = await checkUrl("https://m/x.mp4", "video", { timeoutMs: 1000, fetch: f });
      expect(v).toEqual({ url: "https://m/x.mp4", status: "inconclusive", httpStatus: 0, contentType: "" });
    }
  });
});

describe("runMediaChecks: what gets checked", () => {
  it("checks the video and thumbnail of each eligible active source and stores passes", async () => {
    addSource(state, source(1));
    addSource(state, source(2));
    const { f, calls } = fakeFetch(ok);
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toEqual({ checked: 4, passed: 4, failed: 0, inconclusive: 0, outage: false });
    expect(calls.map((c) => c.url).sort()).toEqual([vurl(1), vurl(2), turl(1), turl(2)].sort());
    expect(state.media(vurl(1))).toEqual({ status: "pass", httpStatus: 200, contentType: "video/mp4", checkedAt: NOW });
    expect(state.media(turl(2))?.contentType).toBe("image/jpeg");
  });

  it("skips ineligible and non-active sources", async () => {
    addSource(state, source(1), "no-title");
    addSource(state, source(2));
    addSource(state, source(3));
    state.setSourceStatus(`${PK}:v3`, "deleted", NOW);
    const { f, calls } = fakeFetch(ok);
    await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls.map((c) => c.url).sort()).toEqual([vurl(2), turl(2)].sort());
  });

  it("skips a missing or non-https thumbnail and records nothing for it", async () => {
    addSource(state, source(1, { image: null }));
    addSource(state, source(2, { image: "http://media.divine.video/thumb-2" }));
    addSource(state, source(3, { image: "not a url" }));
    const { f, calls } = fakeFetch(ok);
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls.map((c) => c.url).sort()).toEqual([vurl(1), vurl(2), vurl(3)].sort());
    expect(r.checked).toBe(3);
    expect(state.media("http://media.divine.video/thumb-2")).toBeUndefined();
  });

  it("never queues an image led by U+00A0 or U+FEFF, which is not an https URL as written", async () => {
    addSource(state, source(1, { image: "\u00a0https://media.divine.video/thumb-1" }));
    addSource(state, source(2, { image: "\ufeffhttps://media.divine.video/thumb-2" }));
    const { f, calls } = fakeFetch(ok);
    await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls.map((c) => c.url).sort()).toEqual([vurl(1), vurl(2)].sort());
  });

  it("does not check an ASCII-padded image: it is no thumbnail, so only the video is checked", async () => {
    const padded = "  https://media.divine.video/thumb-1  ";
    const ev = source(1, { image: padded });
    expect(thumbnailUrl(ev)).toBeUndefined();
    addSource(state, ev);
    const { f, calls } = fakeFetch(ok);
    await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls.map((c) => c.url)).toEqual([vurl(1)]);
    expect(state.media(padded)).toBeUndefined();
  });

  it("does not check a URL that already has a media row, however old", async () => {
    addSource(state, source(1));
    state.putMedia(vurl(1), "pass", 200, "video/mp4", NOW - 400 * DAY);
    state.putMedia(turl(1), "fail", 404, "", NOW - 1);
    const { f, calls } = fakeFetch(ok);
    // no live items, so no rolling recheck either
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls).toHaveLength(0);
    expect(r.checked).toBe(0);
  });

  it("checks a URL shared by two sources once", async () => {
    addSource(state, source(1, { image: "https://media.divine.video/shared" }));
    addSource(state, source(2, { image: "https://media.divine.video/shared" }));
    const { f, calls } = fakeFetch(ok);
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls.filter((c) => c.url.endsWith("/shared"))).toHaveLength(1);
    expect(r.checked).toBe(3);
  });

  it("does not store an inconclusive result, so the URL is picked up again next run", async () => {
    addSource(state, source(1));
    const { f } = fakeFetch((url) => (url.endsWith(".mp4") ? res(503) : res(200, "image/png")));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toMatchObject({ checked: 2, passed: 1, inconclusive: 1, failed: 0, outage: false });
    expect(state.media(vurl(1))).toBeUndefined();
    expect(state.media(turl(1))?.status).toBe("pass");
  });

  it("stores a failure when the failure rate is below the outage threshold", async () => {
    addSource(state, source(1));
    const { f } = fakeFetch((url) => (url.endsWith(".mp4") ? res(404) : res(200, "image/png")));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    // only 2 checks, below the 20-check floor for the outage rule
    expect(r.outage).toBe(false);
    expect(r.failed).toBe(1);
    expect(state.media(vurl(1))).toEqual({ status: "fail", httpStatus: 404, contentType: "", checkedAt: NOW });
  });
});

describe("runMediaChecks: rolling recheck", () => {
  function liveWith(n: number) {
    for (let i = 0; i < n; i++) state.markLive(`d${i}`, "h", "[]", hex(i), NOW, `${PK}:v${i}`);
  }

  it("rechecks ceil(live / recheckDays) of the oldest stale URLs", async () => {
    liveWith(61); // ceil(61 / 30) = 3
    for (let i = 0; i < 5; i++) state.putMedia(`https://m/old-${i}.mp4`, "pass", 200, "video/mp4", NOW - (100 - i) * DAY);
    state.putMedia("https://m/fresh.mp4", "pass", 200, "video/mp4", NOW - DAY);
    const { f, calls } = fakeFetch(ok);
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls.map((c) => c.url)).toEqual(["https://m/old-0.mp4", "https://m/old-1.mp4", "https://m/old-2.mp4"]);
    expect(r.checked).toBe(3);
    expect(state.media("https://m/old-0.mp4")?.checkedAt).toBe(NOW);
    expect(state.media("https://m/old-3.mp4")?.checkedAt).toBe(NOW - 97 * DAY);
  });

  it("does not recheck a URL checked within recheckDays", async () => {
    liveWith(100);
    state.putMedia("https://m/recent.mp4", "pass", 200, "video/mp4", NOW - 29 * DAY);
    const { f, calls } = fakeFetch(ok);
    await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls).toHaveLength(0);
  });

  it("decides the kind of a recheck by suffix: .mp4 is a video, anything else an image", async () => {
    liveWith(60);
    state.putMedia("https://m/a.mp4", "pass", 200, "video/mp4", NOW - 90 * DAY);
    state.putMedia("https://m/thumb", "pass", 200, "image/png", NOW - 80 * DAY);
    // a video URL that now answers with an image type fails, a thumbnail with video/mp4 fails
    const { f } = fakeFetch((url) => (url.endsWith(".mp4") ? res(200, "image/png") : res(200, "video/mp4")));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r.failed).toBe(2);
    expect(state.media("https://m/a.mp4")?.status).toBe("fail");
    expect(state.media("https://m/thumb")?.status).toBe("fail");
  });

  it("does no rechecks with no live items", async () => {
    state.putMedia("https://m/old.mp4", "pass", 200, "video/mp4", NOW - 90 * DAY);
    const { f, calls } = fakeFetch(ok);
    await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls).toHaveLength(0);
  });

  it("does not check a due URL twice when a source also names it", async () => {
    addSource(state, source(1));
    liveWith(30);
    // vurl(1) cannot be due (no row), but a thumbnail row that is stale and also appears as a source thumbnail can be
    state.putMedia(turl(1), "pass", 200, "image/png", NOW - 90 * DAY);
    const { f, calls } = fakeFetch(ok);
    await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(calls.filter((c) => c.url === turl(1))).toHaveLength(1);
  });
});

describe("runMediaChecks: outage protection", () => {
  it("stores no failures when every one of 25 checks fails, and sets outage", async () => {
    for (let i = 0; i < 12; i++) addSource(state, source(i)); // 24 checks
    addSource(state, source(12, { image: null })); // 25th
    const { f } = fakeFetch(() => res(404));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toEqual({ checked: 25, passed: 0, failed: 25, inconclusive: 0, outage: true });
    for (let i = 0; i < 13; i++) expect(state.media(vurl(i))).toBeUndefined();
    expect(state.media(turl(0))).toBeUndefined();
  });

  it("stores the 2 failures from 25 checks when that is under the threshold", async () => {
    for (let i = 0; i < 12; i++) addSource(state, source(i));
    addSource(state, source(12, { image: null }));
    const { f } = fakeFetch((url) => (url === vurl(3) || url === turl(7) ? res(404) : ok(url)));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toEqual({ checked: 25, passed: 23, failed: 2, inconclusive: 0, outage: false });
    expect(state.media(vurl(3))?.status).toBe("fail");
    expect(state.media(turl(7))?.status).toBe("fail");
    expect(state.media(vurl(4))?.status).toBe("pass");
  });

  it("still stores passes during an outage", async () => {
    for (let i = 0; i < 12; i++) addSource(state, source(i)); // 24 checks, 6 pass, 18 fail = 75%
    const { f } = fakeFetch((url) => (url === vurl(0) || url === vurl(1) || url === vurl(2) || url === turl(0) || url === turl(1) || url === turl(2) ? ok(url) : res(404)));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toMatchObject({ checked: 24, passed: 6, failed: 18, outage: true });
    expect(state.media(vurl(0))?.status).toBe("pass");
    expect(state.media(vurl(5))).toBeUndefined();
  });

  it("records nothing as failed for a run of timeouts or 5xx, and flags nothing as an outage by failures", async () => {
    for (let i = 0; i < 12; i++) addSource(state, source(i));
    const { f } = fakeFetch((url) => (url.endsWith(".mp4") ? res(503) : new DOMException("aborted", "AbortError")));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toMatchObject({ checked: 24, passed: 0, failed: 0, inconclusive: 24, outage: false });
    expect(state.mediaDue(NOW + 1, 100)).toEqual([]);
  });

  it("counts inconclusive checks in the denominator", async () => {
    // 24 checks: 4 fail (4/24 = 16.7% of all checks, but 4/6 of conclusive ones), 18 inconclusive, 2 pass
    for (let i = 0; i < 12; i++) addSource(state, source(i));
    const { f } = fakeFetch((url) => {
      if (url === vurl(0) || url === vurl(1) || url === vurl(2) || url === vurl(3)) return res(404);
      if (url === vurl(4) || url === vurl(5)) return ok(url);
      return res(503);
    });
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toMatchObject({ checked: 24, passed: 2, failed: 4, inconclusive: 18, outage: false });
    expect(state.media(vurl(0))?.status).toBe("fail");
  });

  it("does not apply the outage rule under 20 checks", async () => {
    for (let i = 0; i < 9; i++) addSource(state, source(i)); // 18 checks, all fail
    const { f } = fakeFetch(() => res(404));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toMatchObject({ checked: 18, failed: 18, outage: false });
    expect(state.media(vurl(0))?.status).toBe("fail");
  });

  it("applies the outage rule at exactly 20 checks", async () => {
    for (let i = 0; i < 10; i++) addSource(state, source(i));
    const { f } = fakeFetch(() => res(404));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toMatchObject({ checked: 20, failed: 20, outage: true });
  });

  it("does not trip on exactly the threshold fraction", async () => {
    for (let i = 0; i < 10; i++) addSource(state, source(i)); // 20 checks, 4 fail = 0.2, not above
    const { f } = fakeFetch((url) => (url === vurl(0) || url === vurl(1) || url === turl(2) || url === turl(3) ? res(404) : ok(url)));
    const r = await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: noSleep });
    expect(r).toMatchObject({ checked: 20, failed: 4, outage: false });
    expect(state.media(vurl(0))?.status).toBe("fail");
  });
});

describe("runMediaChecks: pacing", () => {
  it("never starts more than requestsPerSecond requests in one second", async () => {
    for (let i = 0; i < 6; i++) addSource(state, source(i)); // 12 requests
    let clock = 0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const { f } = fakeFetch((url) => {
      starts.push(clock);
      return ok(url);
    });
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    };
    await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep });
    expect(starts).toHaveLength(12);
    const rps = cfg.media.requestsPerSecond;
    for (const t of starts) {
      expect(starts.filter((s) => s >= t && s < t + 1000).length).toBeLessThanOrEqual(rps);
    }
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms > 0 && ms <= 1000)).toBe(true);
  });

  it("does not sleep when there are no more requests than one second allows", async () => {
    addSource(state, source(1));
    const sleeps: number[] = [];
    const { f } = fakeFetch(ok);
    await runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([]);
  });
});

describe("runMediaChecks: durability", () => {
  it("keeps the passes of finished batches when the run is aborted, and stores no failures", async () => {
    for (let i = 0; i < 6; i++) addSource(state, source(i)); // 12 requests, batches of 5
    // the queue is vurl(0), turl(0), vurl(1), turl(1), vurl(2) | turl(2), ...: fail the 2nd of batch 1
    const { f } = fakeFetch((url) => (url === turl(0) ? res(404) : ok(url)));
    let sleeps = 0;
    const sleep = async () => {
      if (++sleeps === 2) throw new Error("interrupted");
    };
    await expect(runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep })).rejects.toThrow("interrupted");
    // batches 1 and 2 (10 requests) finished before the second sleep; 1 failed there
    expect(state.media(vurl(0))?.status).toBe("pass");
    expect(state.media(vurl(1))?.status).toBe("pass");
    expect(state.media(turl(2))?.status).toBe("pass");
    expect(state.media(turl(0))).toBeUndefined();
    expect(state.mediaDue(NOW + 1, 100)).toHaveLength(9);
  });

  it("stores the passes of a batch that finished just before the abort", async () => {
    for (let i = 0; i < 3; i++) addSource(state, source(i)); // 6 requests
    const { f } = fakeFetch(ok);
    // the first batch of 5 is done when the sleep before the 6th request rejects
    const sleep = async () => {
      throw new Error("interrupted");
    };
    await expect(runMediaChecks(cfg, state, { now: () => NOW, fetch: f, sleep })).rejects.toThrow("interrupted");
    expect(state.mediaDue(NOW + 1, 100)).toHaveLength(5);
  });
});
