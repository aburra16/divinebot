import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { checkGuards, guardResults, type GuardInput } from "../src/guards.js";
import type { MediaRunResult } from "../src/media.js";

const cfg: Config = loadConfig(new URL("../config.json", import.meta.url).pathname);

const quiet: GuardInput = { liveItems: 0, newOrChanged: 0, deletions: 0, vanished: 0, media: null, sourceEmpty: false };
const input = (over: Partial<GuardInput>): GuardInput => ({ ...quiet, ...over });
const names = (i: GuardInput) => checkGuards(cfg, i).map((b) => b.guard);

const media = (over: Partial<MediaRunResult> = {}): MediaRunResult => ({
  checked: 100,
  passed: 100,
  failed: 0,
  inconclusive: 0,
  outage: false,
  ...over,
});

describe("checkGuards", () => {
  it("passes a quiet run", () => {
    expect(checkGuards(cfg, quiet)).toEqual([]);
  });

  it("trips maxNewOrChanged above 2,000 new or changed items", () => {
    expect(names(input({ newOrChanged: 2000 }))).toEqual([]);
    const breaches = checkGuards(cfg, input({ newOrChanged: 2001 }));
    expect(breaches).toEqual([
      expect.objectContaining({ guard: "maxNewOrChanged", limit: 2000, actual: 2001 }),
    ]);
    expect(breaches[0]!.message).toMatch(/2001 new or changed items/);
  });

  it("applies the deletion floor of 25 to a small list", () => {
    expect(names(input({ liveItems: 1000, deletions: 25 }))).toEqual([]);
    expect(checkGuards(cfg, input({ liveItems: 1000, deletions: 26 }))).toEqual([
      expect.objectContaining({ guard: "maxDeletions", limit: 25, actual: 26 }),
    ]);
  });

  it("allows 2% deletions of a large list", () => {
    expect(names(input({ liveItems: 5000, deletions: 100 }))).toEqual([]);
    expect(checkGuards(cfg, input({ liveItems: 5000, deletions: 101 }))).toEqual([
      expect.objectContaining({ guard: "maxDeletions", limit: 100, actual: 101 }),
    ]);
  });

  it("trips maxVanished above 5% of the live items", () => {
    expect(names(input({ liveItems: 5000, vanished: 250 }))).toEqual([]);
    expect(checkGuards(cfg, input({ liveItems: 5000, vanished: 251 }))).toEqual([
      expect.objectContaining({ guard: "maxVanished", limit: 250, actual: 251 }),
    ]);
  });

  it("trips mediaOutage when the media run reported an outage", () => {
    expect(names(input({ media: media() }))).toEqual([]);
    const breaches = checkGuards(cfg, input({ media: media({ passed: 10, failed: 90, outage: true }) }));
    expect(breaches).toEqual([expect.objectContaining({ guard: "mediaOutage", limit: 0.2, actual: 0.9 })]);
    expect(breaches[0]!.message).toMatch(/outage/);
  });

  it("trips sourceEmpty when the source read nothing for a window that held videos", () => {
    expect(checkGuards(cfg, input({ sourceEmpty: true }))).toEqual([
      expect.objectContaining({ guard: "sourceEmpty" }),
    ]);
  });

  it("reports every breach at once", () => {
    expect(
      names(input({ liveItems: 1000, newOrChanged: 3000, deletions: 30, vanished: 60, sourceEmpty: true })),
    ).toEqual(["maxNewOrChanged", "maxDeletions", "maxVanished", "sourceEmpty"]);
  });

  it("writes messages as plain sentences without em dashes", () => {
    const all = guardResults(
      cfg,
      input({ liveItems: 10, newOrChanged: 3000, deletions: 30, vanished: 60, sourceEmpty: true, media: media({ outage: true, failed: 50 }) }),
    );
    expect(all).toHaveLength(5);
    for (const r of all) {
      expect(r.passed).toBe(false);
      expect(r.message).not.toMatch(/—/);
      expect(r.message).toMatch(/\.$/);
    }
  });

  it("refuses a guard limit that is not a number instead of passing everything", () => {
    const broken = { ...cfg, guards: { ...cfg.guards, maxDeletionsFraction: Number.NaN } };
    expect(() => checkGuards(broken, quiet)).toThrow(/maxDeletionsFraction/);
  });
});
