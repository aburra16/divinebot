import { describe, expect, it } from "vitest";
import { DEFAULT_REHEARSAL_TARGET, loopbackTarget } from "../src/commands/rehearsal-seed.js";

describe("loopbackTarget", () => {
  it.each([DEFAULT_REHEARSAL_TARGET, "ws://localhost:10547", "ws://[::1]:10547"])("accepts %s", (url) => {
    expect(loopbackTarget(url)).toBe(url);
  });

  it.each([
    "wss://dcosl.brainstorm.world",
    "wss://search.brainstorm.world",
    "ws://dcosl.brainstorm.world",
    "wss://127.0.0.1:10547",
    "ws://127.0.0.1.evil.example:10547",
    "ws://user@127.0.0.1:10547",
    "ws://192.168.1.5:10547",
    "http://127.0.0.1:10547",
    "127.0.0.1:10547",
    "",
  ])("refuses %s", (url) => {
    expect(() => loopbackTarget(url)).toThrow();
  });
});
