import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { openState } from "../src/state.js";
import { writeManifest } from "./run-manifest.js";

let err: string[];
let out: string[];

beforeEach(() => {
  err = [];
  out = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void err.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("main", () => {
  it("refuses an unknown command and lists the known ones", async () => {
    expect(await main(["frobnicate"])).toBe(1);
    expect(err.join("\n")).toContain("unknown command: frobnicate");
    const usage = err.join("\n");
    for (const name of ["sync", "sweep", "media", "profiles", "build", "sign", "publish", "verify", "rebroadcast", "profile:publish", "run", "status"]) {
      expect(usage).toContain(name);
    }
  });

  it("refuses no command", async () => {
    expect(await main([])).toBe(1);
    expect(err.join("\n")).toContain("no command given");
  });

  it("refuses build --auto before reading any config", async () => {
    expect(await main(["build", "--auto"])).toBe(1);
    expect(err.join("\n")).toBe("build: build does not take --auto");
  });

  it("refuses a positional argument on sync", async () => {
    expect(await main(["sync", "extra-arg"])).toBe(1);
    expect(err.join("\n")).toBe("sync: sync takes no arguments, got extra-arg");
  });

  it.each([
    ["sync", ["--pilot"]],
    ["sweep", ["--relays", "dcosl"]],
    ["media", ["--first-run"]],
    ["profiles", ["--auto"]],
    ["verify", ["--pilot", "3"]],
    ["status", ["--auto"]],
    ["profile:publish", ["--auto"]],
    ["sign", ["--relays", "dcosl", "run1"]],
    ["publish", ["--auto", "run1"]],
    ["rebroadcast", ["--pilot"]],
    ["run", ["--relays", "dcosl"]],
  ])("%s refuses options it does not take", async (name, args) => {
    expect(await main([name, ...args])).toBe(1);
    expect(err.join("\n")).toMatch(new RegExp(`^${name}: ${name} does not take --`));
  });

  it("refuses positional arguments on the commands that take none", async () => {
    for (const name of ["media", "profiles", "build", "verify", "run", "status", "profile:publish", "sweep"]) {
      err.length = 0;
      expect(await main([name, "stray"])).toBe(1);
      expect(err.join("\n")).toContain(`${name} takes no arguments, got stray`);
    }
  });

  it("sign and publish need exactly one run", async () => {
    for (const name of ["sign", "publish"]) {
      err.length = 0;
      expect(await main([name])).toBe(1);
      expect(err.join("\n")).toMatch(new RegExp(`usage: npm run ${name} -- <run`));
      err.length = 0;
      expect(await main([name, "a", "b"])).toBe(1);
      expect(err.join("\n")).toMatch(new RegExp(`usage: npm run ${name} -- <run`));
    }
  });

  it("reports a bad option from the parser as a plain message", async () => {
    expect(await main(["build", "--bogus"])).toBe(1);
    expect(err.join("\n")).toBe("build: unknown option --bogus");
  });

  it("reports a missing config as a plain message, with no stack trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "divinebot-cli-"));
    const prev = process.env.DIVINEBOT_CONFIG;
    process.env.DIVINEBOT_CONFIG = join(dir, "missing.json");
    try {
      expect(await main(["status"])).toBe(1);
      expect(err.join("\n")).toMatch(/^status: .*missing\.json/);
      expect(err.join("\n")).not.toContain("    at ");
    } finally {
      if (prev === undefined) delete process.env.DIVINEBOT_CONFIG;
      else process.env.DIVINEBOT_CONFIG = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("status prints a summary from a real config and state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "divinebot-cli-"));
    const base = JSON.parse(readFileSync("config.json", "utf8")) as Record<string, unknown>;
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...base, paths: { out: join(dir, "out"), state: join(dir, "state.sqlite") } }));
    const prev = process.env.DIVINEBOT_CONFIG;
    process.env.DIVINEBOT_CONFIG = file;
    try {
      expect(await main(["status"])).toBe(0);
      expect(out.join("\n")).toContain("items: 0 live, 0 deleted");
    } finally {
      if (prev === undefined) delete process.env.DIVINEBOT_CONFIG;
      else process.env.DIVINEBOT_CONFIG = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("publish --settle-refused", () => {
  it("settles the run's refused events, prints each one, and the run is no longer unfinished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "divinebot-cli-settle-"));
    const base = JSON.parse(readFileSync("config.json", "utf8")) as Record<string, unknown>;
    const file = join(dir, "config.json");
    const statePath = join(dir, "state.sqlite");
    writeFileSync(file, JSON.stringify({ ...base, paths: { out: join(dir, "out"), state: statePath } }));
    const prev = process.env.DIVINEBOT_CONFIG;
    process.env.DIVINEBOT_CONFIG = file;
    try {
      const cfg = loadConfig(file);
      const runDir = join(dir, "out", "run1");
      writeManifest(runDir, cfg);
      writeFileSync(join(runDir, "signed.jsonl"), `${JSON.stringify({ id: "f".repeat(64) })}\n`);
      const state = openState(statePath);
      state.recordResult({ eventId: "f".repeat(64), d: "divine-q", kind: 5, createdAt: 1, runId: "run1", relay: "dcosl", ok: true, message: "" });
      state.recordResult({ eventId: "f".repeat(64), d: "divine-q", kind: 5, createdAt: 1, runId: "run1", relay: "search", ok: false, message: "blocked: no" });
      state.close();

      expect(await main(["status"])).toBe(0);
      expect(out.join("\n")).toContain("earlier run run1 is not fully published");
      out.length = 0;

      expect(await main(["publish", "run1", "--settle-refused"])).toBe(0);
      expect(out).toEqual([
        `settled: kind 5 ${"f".repeat(64)} for divine-q on search, refused with: blocked: no`,
        "settled 1 refused event; they will not be sent again",
      ]);
      out.length = 0;
      expect(await main(["status"])).toBe(0);
      expect(out.join("\n")).not.toContain("not fully published");

      out.length = 0;
      expect(await main(["publish", "run1", "--settle-refused"])).toBe(0);
      expect(out.join("\n")).toMatch(/^nothing to settle/);
      expect(await main(["publish", "run1", "--settle-refused", "--relays", "dcosl"])).toBe(1);
      expect(err.join("\n")).toContain("publish does not take --relays");
    } finally {
      if (prev === undefined) delete process.env.DIVINEBOT_CONFIG;
      else process.env.DIVINEBOT_CONFIG = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the lock", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "divinebot-cli-lock-"));
    const base = JSON.parse(readFileSync("config.json", "utf8")) as Record<string, unknown>;
    const file = join(dir, "config.json");
    const statePath = join(dir, "state", "state.sqlite");
    writeFileSync(file, JSON.stringify({ ...base, paths: { out: join(dir, "out"), state: statePath } }));
    mkdirSync(join(dir, "state"));
    // This test runner's own pid: a live process, so the lock is held.
    writeFileSync(`${statePath}.lock`, `${process.pid}\n${new Date().toISOString()}\n`);
    prev = process.env.DIVINEBOT_CONFIG;
    process.env.DIVINEBOT_CONFIG = file;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DIVINEBOT_CONFIG;
    else process.env.DIVINEBOT_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["sync"],
    ["sweep"],
    ["media"],
    ["profiles"],
    ["build"],
    ["verify"],
    ["sign", "run1"],
    ["publish", "run1"],
    ["run"],
  ])("%s refuses while another run holds the lock", async (...argv) => {
    expect(await main(argv)).toBe(1);
    expect(err.join("\n")).toMatch(/another run holds the lock .*state\.sqlite\.lock/);
    // The held lock is left alone.
    expect(readFileSync(join(dir, "state", "state.sqlite.lock"), "utf8")).toContain(String(process.pid));
  });

  it("status does not need the lock", async () => {
    expect(await main(["status"])).toBe(0);
  });
});

describe("the entry point", () => {
  it("exits with the command's code when run as a script", () => {
    const res = spawnSync("node_modules/.bin/tsx", ["src/cli.ts", "build", "--auto"], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("build does not take --auto");
    const unknown = spawnSync("node_modules/.bin/tsx", ["src/cli.ts", "nope"], { encoding: "utf8" });
    // Exit 2 means only "stopped for review"; a usage error is 1.
    expect(unknown.status).toBe(1);
  });
});
