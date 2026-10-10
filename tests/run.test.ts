import { chmodSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPipeline, type PipelineDeps } from "../src/commands/run.js";
import { status } from "../src/commands/status.js";
import type { BuildResult } from "../src/commands/build.js";
import { loadConfig, type Config } from "../src/config.js";
import { withLock } from "../src/lock.js";
import { openState, type State } from "../src/state.js";
import { writeManifest } from "./run-manifest.js";

let dir: string;
let cfg: Config;
let state: State;
let calls: string[];
let logs: string[];
let warnings: string[];

const NOW = 1_800_000_000;
const DAY = 86_400;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divinebot-run-"));
  cfg = {
    ...loadConfig("config.json"),
    relays: { dcosl: "ws://127.0.0.1:9", search: "ws://127.0.0.1:9" },
    paths: { out: join(dir, "out"), state: join(dir, "state", "state.sqlite") },
  };
  state = openState(":memory:");
  calls = [];
  logs = [];
  warnings = [];
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

const syncResult = {
  videos: { new: 3, updated: 0, same: 0, older: 0, rejected: 0 },
  deletions: { applied: 0, ignored: 0 },
  firstHarvest: false,
};
const mediaResult = { checked: 4, passed: 4, failed: 0, inconclusive: 0, outage: false };
const breach = { guard: "maxNewOrChanged", limit: 2000, actual: 2500, message: "2500 new or changed items exceed the limit of 2000" };

interface Fakes {
  breaches?: BuildResult["breaches"];
  created?: number;
  vanished?: string[];
  sweepError?: Error;
  built?: unknown[];
  signCalls?: unknown[];
  publishCalls?: unknown[];
  verifyResult?: Record<string, unknown>;
  publishResult?: Record<string, unknown>;
}

function deps(f: Fakes = {}): Partial<PipelineDeps> {
  return {
    now: () => NOW,
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
    sync: async () => {
      calls.push("sync");
      return syncResult;
    },
    sweep: async () => {
      calls.push("sweep");
      if (f.sweepError) throw f.sweepError;
      return { seen: 10, vanished: f.vanished ?? [], upserted: 0 };
    },
    refreshProfiles: async () => {
      calls.push("profiles");
      return { fetched: 1, verified: 1 };
    },
    runMediaChecks: async () => {
      calls.push("media");
      return mediaResult;
    },
    build: async (_cfg, _state, opts) => {
      calls.push("build");
      f.built?.push(opts);
      const runDir = join(cfg.paths.out, "20270115T080000Z");
      mkdirSync(runDir, { recursive: true });
      return {
        runDir,
        created: f.created ?? 3,
        changed: 0,
        unchanged: 5,
        deletions: 0,
        skipped: {},
        breaches: f.breaches ?? [],
      };
    },
    sign: async (_cfg, _runDir, opts) => {
      calls.push("sign");
      f.signCalls?.push(opts);
      return { signed: 3, pubkey: "a".repeat(64) };
    },
    publish: async (_cfg, _state, _runDir, relays, opts) => {
      calls.push("publish");
      f.publishCalls?.push(relays);
      opts?.onNotice?.("deletion refused by search; the relay never held the item (divine-x, event e)");
      return (f.publishResult ?? {
        dcosl: { sent: 3, ok: 3, failed: 0, skipped: 0 },
        search: { sent: 3, ok: 3, failed: 0, skipped: 0 },
      }) as never;
    },
    verify: async () => {
      calls.push("verify");
      return (f.verifyResult ?? {
        dcosl: { onRelay: 3, inState: 3, missing: [], extra: [], stale: [], extraCheck: "complete" },
        search: { onRelay: 3, inState: 3, missing: [], extra: [], stale: [], extraCheck: "complete" },
      }) as never;
    },
  };
}

describe("runPipeline, manual", () => {
  it("syncs, refreshes profiles, checks media and builds, then stops without signing", async () => {
    state.setCursor("videos", NOW - 100);
    state.setCursor("last_sweep", NOW - DAY);
    const built: unknown[] = [];
    const out = await runPipeline(cfg, state, { auto: false, deps: deps({ built }) });
    expect(calls).toEqual(["sync", "profiles", "media", "build"]);
    expect(out.exitCode).toBe(0);
    expect(out.stoppedForReview).toBe(false);
    expect(out.runDir).toBe(join(cfg.paths.out, "20270115T080000Z"));
    expect(built[0]).toMatchObject({ sync: syncResult, media: mediaResult, vanished: 0, pilot: undefined, firstRun: undefined });
    const text = logs.join("\n");
    expect(text).toContain("20270115T080000Z");
    expect(text).toContain("npm run sign -- 20270115T080000Z");
    expect(text).toContain("npm run publish -- 20270115T080000Z");
  });

  it("passes pilot and firstRun to build and still exits 0 with breaches", async () => {
    const built: unknown[] = [];
    const out = await runPipeline(cfg, state, { auto: false, pilot: 5, firstRun: true, deps: deps({ built, breaches: [breach] }) });
    expect(built[0]).toMatchObject({ pilot: 5, firstRun: true });
    expect(out.exitCode).toBe(0);
    expect(out.breaches).toEqual([breach]);
    expect(logs.join("\n")).toContain(breach.message);
    expect(calls).not.toContain("sign");
  });

  it("prints the warnings about earlier unfinished runs", async () => {
    const earlier = join(cfg.paths.out, "20260101T000000Z");
    writeManifest(earlier, cfg);
    writeFileSync(join(earlier, "unsigned.jsonl"), '{"kind":39999}\n');
    await runPipeline(cfg, state, { auto: false, deps: deps() });
    expect(warnings.join("\n")).toContain("earlier run 20260101T000000Z is not fully published");
  });
});

describe("runPipeline, sweep cadence", () => {
  it("sweeps when there is no earlier sweep and the videos cursor exists, and passes the vanished count", async () => {
    state.setCursor("videos", NOW - 100);
    const built: unknown[] = [];
    await runPipeline(cfg, state, { auto: false, deps: deps({ built, vanished: ["a:1", "a:2"] }) });
    expect(calls).toEqual(["sync", "sweep", "profiles", "media", "build"]);
    expect(built[0]).toMatchObject({ vanished: 2 });
  });

  it("sweeps when the last sweep is older than 7 days", async () => {
    state.setCursor("videos", NOW - 100);
    state.setCursor("last_sweep", NOW - 7 * DAY - 1);
    await runPipeline(cfg, state, { auto: false, deps: deps() });
    expect(calls).toContain("sweep");
  });

  it("does not sweep within 7 days", async () => {
    state.setCursor("videos", NOW - 100);
    state.setCursor("last_sweep", NOW - 7 * DAY + 60);
    await runPipeline(cfg, state, { auto: false, deps: deps() });
    expect(calls).not.toContain("sweep");
  });

  it("carries on with vanished 0 and a warning when the sweep throws, and an auto run still publishes", async () => {
    state.setCursor("videos", NOW - 100);
    const built: unknown[] = [];
    const sweepError = new Error("the sweep read no videos; nothing was marked vanished; run npm run sweep again later");
    const out = await runPipeline(cfg, state, { auto: true, deps: deps({ built, sweepError }) });
    expect(calls).toEqual(["sync", "sweep", "profiles", "media", "build", "sign", "publish", "verify"]);
    expect(built[0]).toMatchObject({ vanished: 0 });
    expect(out.exitCode).toBe(0);
    expect(warnings).toContain(
      "warning: the sweep failed, so this run marks nothing vanished: the sweep read no videos; nothing was marked vanished; run npm run sweep again later",
    );
  });

  it("never sweeps on a first harvest", async () => {
    await runPipeline(cfg, state, { auto: false, firstRun: true, deps: deps() });
    expect(calls).not.toContain("sweep");
  });
});

describe("runPipeline, auto", () => {
  it("refuses pilot and first-run before doing anything", async () => {
    await expect(runPipeline(cfg, state, { auto: true, pilot: 5, deps: deps() })).rejects.toThrow(/--auto.*--pilot|pilot.*--auto/);
    await expect(runPipeline(cfg, state, { auto: true, firstRun: true, deps: deps() })).rejects.toThrow(/first-run/);
    expect(calls).toEqual([]);
    expect(existsSync(`${cfg.paths.state}.lock`)).toBe(false);
  });

  it("stops for review on a guard breach: writes NEEDS_REVIEW, never signs, returns 2", async () => {
    const out = await runPipeline(cfg, state, { auto: true, deps: deps({ breaches: [breach] }) });
    expect(out.exitCode).toBe(2);
    expect(out.stoppedForReview).toBe(true);
    expect(out.breaches).toEqual([breach]);
    expect(readFileSync(join(out.runDir!, "NEEDS_REVIEW"), "utf8")).toBe(`${breach.message}\n`);
    expect(calls).toEqual(["sync", "profiles", "media", "build"]);
  });

  it("with an earlier unfinished run, keeps state current but builds nothing, signs nothing and returns 2", async () => {
    state.setCursor("videos", NOW - 100);
    state.setCursor("last_sweep", NOW - 8 * DAY);
    const earlier = join(cfg.paths.out, "20260101T000000Z");
    writeManifest(earlier, cfg);
    writeFileSync(join(earlier, "unsigned.jsonl"), '{"kind":39999}\n');
    const out = await runPipeline(cfg, state, { auto: true, deps: deps() });
    expect(out).toEqual({ runDir: null, stoppedForReview: true, breaches: [], exitCode: 2 });
    expect(calls).toEqual(["sync", "sweep", "profiles", "media"]);
    expect(readdirSync(cfg.paths.out)).toEqual(["20260101T000000Z"]);
    expect(warnings.join("\n")).toContain("earlier run 20260101T000000Z is not fully published: not signed");
    expect(warnings.join("\n")).toContain("delete its folder under out/");
  });

  it("writes NEEDS_REVIEW only for a run it built, one line per breach", async () => {
    const two = [breach, { ...breach, guard: "vanished", message: "40 videos vanished" }];
    const out = await runPipeline(cfg, state, { auto: true, deps: deps({ breaches: two }) });
    expect(readFileSync(join(out.runDir!, "NEEDS_REVIEW"), "utf8")).toBe(`${breach.message}\n40 videos vanished\n`);
  });

  it("signs, publishes to every relay and verifies, in that order, when nothing needs review", async () => {
    const signCalls: { keyPath?: string }[] = [];
    const publishCalls: unknown[] = [];
    const out = await runPipeline(cfg, state, { auto: true, deps: deps({ signCalls, publishCalls }) });
    expect(calls).toEqual(["sync", "profiles", "media", "build", "sign", "publish", "verify"]);
    expect(out.exitCode).toBe(0);
    expect(out.stoppedForReview).toBe(false);
    expect(existsSync(join(out.runDir!, "NEEDS_REVIEW"))).toBe(false);
    expect(publishCalls).toEqual([undefined]);
    expect(signCalls[0]!.keyPath).toBeTypeOf("string");
  });

  it("skips signing and publishing for a run with nothing to publish, but still verifies", async () => {
    const out = await runPipeline(cfg, state, { auto: true, deps: deps({ created: 0 }) });
    expect(calls).toEqual(["sync", "profiles", "media", "build", "verify"]);
    expect(out.exitCode).toBe(0);
  });

  it("completes when the only refusals were settled, prints them and passes notices on as warnings", async () => {
    const publishResult = {
      dcosl: { sent: 3, ok: 3, failed: 0, skipped: 0 },
      search: { sent: 3, ok: 2, failed: 0, skipped: 0, settled: 1 },
    };
    const out = await runPipeline(cfg, state, { auto: true, deps: deps({ publishResult }) });
    expect(out.exitCode).toBe(0);
    expect(calls).toContain("verify");
    expect(logs).toContain("search: sent 3, ok 2, failed 0, skipped 0, settled 1");
    expect(warnings).toContain("deletion refused by search; the relay never held the item (divine-x, event e)");
  });

  it("fails with a plain message when a relay did not accept every event", async () => {
    const publishResult = {
      dcosl: { sent: 3, ok: 3, failed: 0, skipped: 0 },
      search: { sent: 3, ok: 1, failed: 2, skipped: 0 },
    };
    await expect(runPipeline(cfg, state, { auto: true, deps: deps({ publishResult }) })).rejects.toThrow(
      /not every event was accepted on search/,
    );
    expect(calls).not.toContain("verify");
  });

  it("fails when the relays and state do not match after publishing", async () => {
    const verifyResult = {
      dcosl: { onRelay: 2, inState: 3, missing: ["x"], extra: [], stale: [], extraCheck: "complete" },
      search: { onRelay: 3, inState: 3, missing: [], extra: [], stale: [], extraCheck: "complete" },
    };
    await expect(runPipeline(cfg, state, { auto: true, deps: deps({ verifyResult }) })).rejects.toThrow(
      /relays and state do not match on dcosl/,
    );
  });

  describe("the passphrase for an encrypted key", () => {
    const saved = process.env.DIVINEBOT_PASSPHRASE_FILE;
    afterEach(() => {
      if (saved === undefined) delete process.env.DIVINEBOT_PASSPHRASE_FILE;
      else process.env.DIVINEBOT_PASSPHRASE_FILE = saved;
    });

    async function asker() {
      const signCalls: { askPassphrase?: () => Promise<string> }[] = [];
      await runPipeline(cfg, state, { auto: true, deps: deps({ signCalls }) });
      return signCalls[0]!.askPassphrase!;
    }

    it("is read from DIVINEBOT_PASSPHRASE_FILE", async () => {
      const file = join(dir, "pass");
      writeFileSync(file, "correct horse\n");
      chmodSync(file, 0o600);
      process.env.DIVINEBOT_PASSPHRASE_FILE = file;
      expect(await (await asker())()).toBe("correct horse");
    });

    it("is refused, never asked at a terminal, when the variable is unset or empty", async () => {
      delete process.env.DIVINEBOT_PASSPHRASE_FILE;
      const ask = await asker();
      await expect(ask()).rejects.toThrow(/DIVINEBOT_PASSPHRASE_FILE/);
      process.env.DIVINEBOT_PASSPHRASE_FILE = "";
      await expect(ask()).rejects.toThrow(/DIVINEBOT_PASSPHRASE_FILE/);
    });
  });
});

describe("runPipeline, lock", () => {
  it("refuses a second run while one holds the lock, and releases the lock afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = deps();
    slow.sync = async () => {
      await gate;
      return syncResult;
    };
    const first = runPipeline(cfg, state, { auto: false, deps: slow });
    await expect(runPipeline(cfg, state, { auto: false, deps: deps() })).rejects.toThrow(/lock/);
    release();
    await first;
    expect(existsSync(`${cfg.paths.state}.lock`)).toBe(false);
    await expect(runPipeline(cfg, state, { auto: false, deps: deps() })).resolves.toMatchObject({ exitCode: 0 });
  });

  it("releases the lock when a step throws", async () => {
    const failing = deps();
    failing.sync = async () => {
      throw new Error("the source relay is down");
    };
    await expect(runPipeline(cfg, state, { auto: false, deps: failing })).rejects.toThrow(/source relay is down/);
    expect(existsSync(`${cfg.paths.state}.lock`)).toBe(false);
  });
});

describe("withLock", () => {
  const lockPath = () => join(dir, "x", "state.lock");

  it("writes the pid and an ISO time while held, and removes the file after", async () => {
    await withLock(lockPath(), async () => {
      const [pid, time] = readFileSync(lockPath(), "utf8").trim().split("\n");
      expect(pid).toBe(String(process.pid));
      expect(new Date(time!).toISOString()).toBe(time);
    });
    expect(existsSync(lockPath())).toBe(false);
  });

  it("refuses a lock held less than 6 hours, naming the file, and leaves it alone", async () => {
    mkdirSync(join(dir, "x"), { recursive: true });
    writeFileSync(lockPath(), `4242\n${new Date((NOW - 5 * 3600) * 1000).toISOString()}\n`);
    await expect(withLock(lockPath(), async () => 1, { now: () => NOW * 1000 })).rejects.toThrow(/state\.lock.*4242|4242.*state\.lock/);
    expect(existsSync(lockPath())).toBe(true);
  });

  it("replaces a lock older than 6 hours, with a warning", async () => {
    mkdirSync(join(dir, "x"), { recursive: true });
    writeFileSync(lockPath(), `4242\n${new Date((NOW - 7 * 3600) * 1000).toISOString()}\n`);
    const warned: string[] = [];
    const result = await withLock(lockPath(), async () => "ran", { now: () => NOW * 1000, warn: (m) => warned.push(m) });
    expect(result).toBe("ran");
    expect(warned.join("\n")).toMatch(/stale|older than 6 hours/);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("removes the lock when the function throws", async () => {
    await expect(withLock(lockPath(), async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(lockPath())).toBe(false);
  });
});

function sourceEvent(n: number, kind = 34236): NostrEvent {
  return { id: String(n).padStart(64, "0"), pubkey: "b".repeat(64), created_at: 1000 + n, kind, tags: [["d", `v${n}`]], content: "", sig: "c".repeat(128) };
}

describe("status", () => {
  it("reports an empty state in plain lines", () => {
    const text = status(cfg, state);
    expect(text).toContain("items: 0 live, 0 deleted");
    expect(text).toContain("videos cursor: never");
    expect(text).toContain("no relay has had a run yet");
    expect(text).not.toContain("NEEDS_REVIEW");
    expect(text).not.toContain("unfinished runs");
  });

  it("lists earlier unfinished runs, the real gate, and says how to clear them", () => {
    const earlier = join(cfg.paths.out, "20260101T000000Z");
    writeManifest(earlier, cfg);
    writeFileSync(join(earlier, "unsigned.jsonl"), '{"kind":39999}\n');
    writeFileSync(join(earlier, "NEEDS_REVIEW"), "x\n");
    const text = status(cfg, state);
    expect(text).toContain("unfinished runs");
    expect(text).toContain("warning: earlier run 20260101T000000Z is not fully published: not signed");
    expect(text).toContain("sign and publish the run you want to keep, or delete the run's folder under out/ to discard it");
    expect(text).toContain("NEEDS_REVIEW is only a marker; deleting it unblocks nothing");
  });

  it("counts items, eligible sources by class, skips by reason, cursors, relays and review dirs", () => {
    state.markLive("divine-b-v1", "h", "[]", "e".repeat(64), 1, "b:v1");
    state.markLive("divine-b-v2", "h", "[]", "f".repeat(64), 1, "b:v2");
    state.markDeleted("divine-b-v2", 2);
    state.upsertSource(sourceEvent(1), "native", null, 1);
    state.upsertSource(sourceEvent(2), "native", null, 1);
    state.upsertSource(sourceEvent(3), "vine", null, 1);
    state.upsertSource(sourceEvent(4), "native", "no video hash", 1);
    state.upsertSource(sourceEvent(5), "native", "no video hash", 1);
    state.upsertSource(sourceEvent(6), "native", "too short", 1);
    state.setCursor("videos", 1_800_000_000);
    state.recordResult({ eventId: "e".repeat(64), d: "divine-b-v1", kind: 39999, createdAt: 1, runId: "20270101T000000Z", relay: "dcosl", ok: true, message: "" });
    state.recordResult({ eventId: "f".repeat(64), d: "divine-b-v2", kind: 39999, createdAt: 1, runId: "20270101T000000Z", relay: "dcosl", ok: false, message: "x" });
    state.recordResult({ eventId: "e".repeat(64), d: "divine-b-v1", kind: 39999, createdAt: 1, runId: "20270102T000000Z", relay: "dcosl", ok: true, message: "" });
    mkdirSync(join(cfg.paths.out, "20270102T000000Z"), { recursive: true });
    writeFileSync(join(cfg.paths.out, "20270102T000000Z", "NEEDS_REVIEW"), "x\n");
    mkdirSync(join(cfg.paths.out, "20270101T000000Z"), { recursive: true });

    const text = status(cfg, state);
    expect(text).toContain("items: 1 live, 1 deleted");
    expect(text).toMatch(/eligible sources: native 2, vine 1, user-submitted 0/);
    expect(text).toMatch(/no video hash: 2/);
    expect(text).toMatch(/too short: 1/);
    expect(text).toContain("videos cursor: 2027-01-15 08:00:00 UTC");
    expect(text).toContain("deletions cursor: never");
    expect(text).toMatch(/dcosl: run 20270102T000000Z, 1 accepted, 0 failed/);
    expect(text).toMatch(/NEEDS_REVIEW.*: .*20270102T000000Z/);
    expect(text).not.toMatch(/NEEDS_REVIEW.*: .*20270101T000000Z/);
  });
});
