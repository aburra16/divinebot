import { describe, expect, it } from "vitest";
import { givenOptions, parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("defaults to no options", () => {
    expect(parseArgs([])).toEqual({ positional: [] });
  });

  it("takes --pilot with or without a size", () => {
    expect(parseArgs(["--pilot"]).pilot).toBe("default");
    expect(parseArgs(["--pilot", "20"]).pilot).toBe(20);
    expect(parseArgs(["--pilot", "--auto"])).toEqual({ positional: [], pilot: "default", auto: true });
  });

  it("refuses a pilot size of 0", () => {
    expect(() => parseArgs(["--pilot", "0"])).toThrow(/--pilot/);
  });

  it("takes --auto as a flag", () => {
    expect(parseArgs(["--auto"])).toEqual({ positional: [], auto: true });
    expect(parseArgs([]).auto).toBeUndefined();
  });

  it("takes --first-run as a flag", () => {
    expect(parseArgs(["--first-run", "--pilot"])).toEqual({
      positional: [],
      pilot: "default",
      firstRun: true,
    });
    expect(parseArgs([]).firstRun).toBeUndefined();
  });

  it("takes --settle-refused as a flag", () => {
    expect(parseArgs(["run1", "--settle-refused"])).toEqual({ positional: ["run1"], settleRefused: true });
    expect(givenOptions(parseArgs(["--settle-refused"]))).toEqual(["--settle-refused"]);
  });

  it("splits --relays on commas", () => {
    expect(parseArgs(["--relays", "dcosl, search"]).relays).toEqual(["dcosl", "search"]);
    expect(() => parseArgs(["--relays"])).toThrow(/--relays/);
  });

  it("keeps positional arguments and refuses unknown options", () => {
    expect(parseArgs(["out/r1"]).positional).toEqual(["out/r1"]);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option --bogus/);
  });

  it("no longer takes the options mise-en-place had", () => {
    for (const argv of [["--filter", "a=b"], ["--port", "80"], ["--allow-deletions=3"]]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(/unknown option/);
    }
  });
});

describe("givenOptions", () => {
  it("lists the options present, for a command to refuse the ones it does not take", () => {
    expect(givenOptions(parseArgs(["out/r1"]))).toEqual([]);
    expect(givenOptions(parseArgs(["--pilot", "5", "--relays", "dcosl", "--auto", "--first-run"]))).toEqual([
      "--pilot",
      "--relays",
      "--auto",
      "--first-run",
    ]);
  });
});
