import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { earlierRunWarnings } from "../src/earlier-runs.js";
import { openState, type State } from "../src/state.js";
import { writeManifest } from "./run-manifest.js";

let dir: string;
let cfg: Config;
let state: State;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divinebot-earlier-"));
  cfg = {
    ...loadConfig("config.json"),
    relays: { dcosl: "ws://127.0.0.1:9", search: "ws://127.0.0.1:9" },
    paths: { out: join(dir, "out"), state: ":memory:" },
  };
  state = openState(":memory:");
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function run(name: string, files: Record<string, string>): void {
  const runDir = join(cfg.paths.out, name);
  writeManifest(runDir, cfg);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(runDir, file), text);
}

const signedLine = (id: string) => `${JSON.stringify({ id })}\n`;
const record = (eventId: string, relay: string) =>
  state.recordResult({ eventId, d: "x", kind: 39999, createdAt: 1, runId: "r", relay, ok: true, message: "" });

describe("earlierRunWarnings", () => {
  it("is empty when out/ does not exist", () => {
    expect(earlierRunWarnings(cfg, state)).toEqual([]);
  });

  it("warns about a built run that was never signed, and ignores an empty one and a dir with no manifest", () => {
    run("a-unsigned", { "unsigned.jsonl": '{"kind":39999}\n' });
    run("b-empty", { "unsigned.jsonl": "" });
    mkdirSync(join(cfg.paths.out, "c-not-a-run"), { recursive: true });
    expect(earlierRunWarnings(cfg, state)).toEqual(["warning: earlier run a-unsigned is not fully published: not signed"]);
  });

  it("names the relays that lack a signed run's events, with the command that finishes it", () => {
    run("d-signed", { "unsigned.jsonl": "{}\n", "signed.jsonl": signedLine("1".repeat(64)) + signedLine("2".repeat(64)) });
    record("1".repeat(64), "dcosl");
    record("2".repeat(64), "dcosl");
    record("1".repeat(64), "search");
    expect(earlierRunWarnings(cfg, state)).toEqual([
      "warning: earlier run d-signed is not fully published: not published to search: 1 of 2 events missing; " +
        "finish it with: npm run publish -- d-signed --relays search",
    ]);
  });

  it("is quiet for a fully published run", () => {
    run("e-done", { "unsigned.jsonl": "{}\n", "signed.jsonl": signedLine("3".repeat(64)) });
    record("3".repeat(64), "dcosl");
    record("3".repeat(64), "search");
    expect(earlierRunWarnings(cfg, state)).toEqual([]);
  });

  it("reports a signed.jsonl line with no id instead of throwing", () => {
    run("f-bad", { "unsigned.jsonl": "{}\n", "signed.jsonl": "{nope\n" });
    expect(earlierRunWarnings(cfg, state)).toEqual([
      "warning: could not check earlier run f-bad: signed.jsonl line 1 is not a nostr event with an id",
    ]);
  });
});
