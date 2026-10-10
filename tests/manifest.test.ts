import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRunConfig, configIdentity, manifestRelays, type IdentitySource } from "../src/manifest.js";
import { writeManifest } from "./run-manifest.js";

const cfg: IdentitySource = {
  headerCoordinate: `39998:${"b".repeat(64)}:divine-videos`,
  curatorPubkey: "c".repeat(64),
  templateIds: { "divine-video": "1".repeat(64), "divine-profile": "2".repeat(64) },
  relays: { dcosl: "wss://dcosl.example", search: "wss://search.example" },
  scope: { includeVines: true },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divinebot-manifest-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("configIdentity", () => {
  it("covers the header, curator, templates, relays and scope", () => {
    expect(Object.keys(configIdentity(cfg)).sort()).toEqual([
      "curatorPubkey",
      "headerCoordinate",
      "relays",
      "scope",
      "templateIds",
    ]);
  });
});

describe("checkRunConfig", () => {
  it("accepts a run recorded with the same config, whatever order its keys are in", () => {
    writeManifest(dir, {
      ...cfg,
      relays: { search: "wss://search.example", dcosl: "wss://dcosl.example" },
      templateIds: { "divine-profile": "2".repeat(64), "divine-video": "1".repeat(64) },
    });
    expect(() => checkRunConfig(cfg, dir)).not.toThrow();
  });

  it.each([
    ["headerCoordinate", { headerCoordinate: `39998:${"d".repeat(64)}:other` }],
    ["curatorPubkey", { curatorPubkey: "d".repeat(64) }],
    ["templateIds", { templateIds: { "divine-video": "9".repeat(64), "divine-profile": "2".repeat(64) } }],
    ["relays", { relays: { dcosl: "ws://127.0.0.1:1" } }],
    ["scope", { scope: { includeVines: false } }],
  ])("refuses a run built with another %s, naming it", (field, over) => {
    writeManifest(dir, cfg, over);
    expect(() => checkRunConfig(cfg, dir)).toThrow(new RegExp(`${field} is`));
  });

  it("refuses a run with no manifest, or one that records no config", () => {
    expect(() => checkRunConfig(cfg, dir)).toThrow(/not found/);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ runId: "r" }));
    expect(() => checkRunConfig(cfg, dir)).toThrow(/records no config/);
  });

  it("points at DIVINEBOT_CONFIG, not at mise-en-place", () => {
    writeManifest(dir, cfg, { scope: { includeVines: false } });
    expect(() => checkRunConfig(cfg, dir)).toThrow(/DIVINEBOT_CONFIG/);
  });
});

describe("manifestRelays", () => {
  it("lists the relay names the run was built for, and nothing when it cannot be read", () => {
    expect(manifestRelays(join(dir, "missing"))).toBeUndefined();
    mkdirSync(dir, { recursive: true });
    writeManifest(dir, cfg);
    expect(manifestRelays(dir)).toEqual(["dcosl", "search"]);
  });
});
