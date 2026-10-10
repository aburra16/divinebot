import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, readSearch, relayUrl } from "../src/config.js";

const DIVINE_VIDEO_TEMPLATE = "97d7f683f8cfea346e389042430e1795fc6ddae25ee9dff298c95867d707b7ee";

function goodConfig(): Record<string, any> {
  return JSON.parse(readFileSync("config.json", "utf8"));
}

/** Writes `cfg` to a temp file and returns its path. */
function writeTemp(cfg: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "divinebot-config-"));
  const file = join(dir, "config.json");
  writeFileSync(file, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  return file;
}

afterEach(() => {
  delete process.env.DIVINEBOT_CONFIG;
});

describe("loadConfig", () => {
  it("reads config.json and returns the template ids", () => {
    const cfg = loadConfig();
    expect(cfg.templateIds["divine-video"]).toBe(DIVINE_VIDEO_TEMPLATE);
    expect(cfg.templateIds["divine-profile"]).toBe("f07980288c1036e748bf80070b07cc2780a295b3ee15dd8b306dfea87abafd20");
    expect(cfg.curatorPubkey).toBe("6b279fb268a564ef74f35533f58a165fd4846b9c5595ac0bfc38cab37fda559d");
    expect(cfg.guards.maxNewOrChanged).toBe(2000);
    expect(cfg.scope.includeVines).toBe(false);
  });

  it("accepts the rehearsal example", () => {
    const cfg = loadConfig("config.rehearsal.example.json");
    expect(cfg.paths.state).toBe("state/rehearsal/state.sqlite");
    expect(cfg.relayReadSearch).toBeUndefined();
    expect(relayUrl(cfg, "dcosl")).toBe("ws://127.0.0.1:10547");
    expect(relayUrl(cfg, "search")).toBe("ws://127.0.0.1:10547");
  });

  it("names the file and the field when guards.maxNewOrChanged is missing", () => {
    const cfg = goodConfig();
    delete cfg.guards.maxNewOrChanged;
    const file = writeTemp(cfg);
    expect(() => loadConfig(file)).toThrow(file);
    expect(() => loadConfig(file)).toThrow("guards.maxNewOrChanged");
  });

  it("rejects a template id that is not 64 hex characters", () => {
    const cfg = goodConfig();
    cfg.templateIds["divine-video"] = "97d7f683";
    expect(() => loadConfig(writeTemp(cfg))).toThrow("templateIds.divine-video");

    const upper = goodConfig();
    upper.templateIds["divine-profile"] = "F".repeat(64);
    expect(() => loadConfig(writeTemp(upper))).toThrow("templateIds.divine-profile");
  });

  it("rejects a source.relay that is not a ws:// or wss:// URL", () => {
    const cfg = goodConfig();
    cfg.source.relay = "https://relay.divine.video";
    expect(() => loadConfig(writeTemp(cfg))).toThrow("source.relay");
  });

  it("rejects a media.base that is not an http(s) URL", () => {
    const cfg = goodConfig();
    cfg.media.base = "wss://media.divine.video";
    expect(() => loadConfig(writeTemp(cfg))).toThrow("media.base");
  });

  it("uses DIVINEBOT_CONFIG when no path is given", () => {
    const cfg = goodConfig();
    cfg.pilotSize = 7;
    process.env.DIVINEBOT_CONFIG = writeTemp(cfg);
    expect(loadConfig().pilotSize).toBe(7);
  });

  it("prefers an explicit path over DIVINEBOT_CONFIG", () => {
    process.env.DIVINEBOT_CONFIG = join(tmpdir(), "does-not-exist.json");
    expect(loadConfig("config.json").pilotSize).toBe(150);
  });

  it("rejects text that is not JSON, naming the file", () => {
    const file = writeTemp("{ nope");
    expect(() => loadConfig(file)).toThrow(file);
    expect(() => loadConfig(file)).toThrow("not valid JSON");
  });

  it.each([
    ["headerCoordinate", (c: any) => (c.headerCoordinate = "39998:abc:divine-videos")],
    ["curatorPubkey", (c: any) => (c.curatorPubkey = "xyz")],
    ["headerRelay", (c: any) => (c.headerRelay = "nowhere")],
    ["relays.dcosl", (c: any) => (c.relays.dcosl = "dcosl.brainstorm.world")],
    ["relayReadSearch.search", (c: any) => (c.relayReadSearch.search = " ")],
    ["relayReadSearch.nowhere", (c: any) => (c.relayReadSearch.nowhere = "include:spam")],
    ["source.pageSize", (c: any) => (c.source.pageSize = 0)],
    ["source.pageDelayMs", (c: any) => (c.source.pageDelayMs = -1)],
    ["source.harvestSince", (c: any) => (c.source.harvestSince = 1.5)],
    ["source.overlapSeconds", (c: any) => (c.source.overlapSeconds = "3600")],
    ["source.readTimeoutMs", (c: any) => delete c.source.readTimeoutMs],
    ["media.requestsPerSecond", (c: any) => (c.media.requestsPerSecond = 0)],
    ["media.recheckDays", (c: any) => (c.media.recheckDays = null)],
    ["media.timeoutMs", (c: any) => (c.media.timeoutMs = 0)],
    ["profiles.batchSize", (c: any) => (c.profiles.batchSize = 0.5)],
    ["profiles.refreshDays", (c: any) => (c.profiles.refreshDays = 0)],
    ["profiles.nip05TtlDays", (c: any) => (c.profiles.nip05TtlDays = 0)],
    ["profiles.nip05TimeoutMs", (c: any) => (c.profiles.nip05TimeoutMs = 0)],
    ["profileRelays", (c: any) => (c.profileRelays = [])],
    ["profileRelays[1]", (c: any) => (c.profileRelays[1] = "https://nos.lol")],
    ["scope.includeVines", (c: any) => (c.scope.includeVines = "no")],
    ["publish.eventsPerSecond", (c: any) => (c.publish.eventsPerSecond = 0)],
    ["publish.okTimeoutMs", (c: any) => delete c.publish.okTimeoutMs],
    ["guards.maxDeletionsFloor", (c: any) => (c.guards.maxDeletionsFloor = -1)],
    ["guards.maxDeletionsFraction", (c: any) => (c.guards.maxDeletionsFraction = 2)],
    ["guards.maxVanishedFraction", (c: any) => (c.guards.maxVanishedFraction = "5%")],
    ["guards.maxMediaFailureFraction", (c: any) => (c.guards.maxMediaFailureFraction = -0.1)],
    ["pilotSize", (c: any) => (c.pilotSize = 0)],
    ["paths.out", (c: any) => (c.paths.out = "")],
    ["paths.state", (c: any) => delete c.paths.state],
  ])("rejects a bad %s, naming the field", (field, mutate) => {
    const cfg = goodConfig();
    mutate(cfg);
    const file = writeTemp(cfg);
    expect(() => loadConfig(file)).toThrow(file);
    expect(() => loadConfig(file)).toThrow(field);
  });

  it("rejects a missing top-level section", () => {
    for (const key of ["templateIds", "source", "media", "profiles", "scope", "publish", "guards", "paths"]) {
      const cfg = goodConfig();
      delete cfg[key];
      expect(() => loadConfig(writeTemp(cfg))).toThrow(key);
    }
  });
});

describe("relayUrl and readSearch", () => {
  it("looks up a relay by name and lists the names for an unknown one", () => {
    const cfg = loadConfig();
    expect(relayUrl(cfg, "dcosl")).toBe("wss://dcosl.brainstorm.world");
    expect(() => relayUrl(cfg, "nowhere")).toThrow("dcosl, search");
  });

  it("returns the search string only for relays that have one", () => {
    const cfg = loadConfig();
    expect(readSearch(cfg, "search")).toBe("include:spam");
    expect(readSearch(cfg, "dcosl")).toBeUndefined();
    expect(readSearch({}, "search")).toBeUndefined();
  });
});
