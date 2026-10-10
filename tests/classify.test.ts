import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools/core";
import { classOf, imeta, skipReason, slim, titleOf } from "../src/source/classify.js";

function load(name: string): NostrEvent[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as NostrEvent);
}

const native = load("native");
const vine = load("vine");
const scope = { includeVines: false };

function withTags(ev: NostrEvent, f: (tags: string[][]) => string[][]): NostrEvent {
  return { ...ev, tags: f(ev.tags.map((t) => [...t])) };
}
function setTag(ev: NostrEvent, name: string, ...values: string[]): NostrEvent {
  return withTags(ev, (tags) => [...tags.filter((t) => t[0] !== name), [name, ...values]]);
}
function setImeta(ev: NostrEvent, key: string, value: string): NostrEvent {
  return withTags(ev, (tags) =>
    tags.map((t) =>
      t[0] === "imeta" ? t.map((e) => (e.startsWith(`${key} `) ? `${key} ${value}` : e)) : t,
    ),
  );
}
const first = native[0]!;

describe("classOf", () => {
  it("classifies every native fixture as native", () => {
    expect(native).toHaveLength(50);
    for (const ev of native) expect(classOf(ev)).toBe("native");
  });
  it("classifies every Vine fixture as vine and skips it as classic-vine", () => {
    expect(vine).toHaveLength(50);
    for (const ev of vine) {
      expect(classOf(ev)).toBe("vine");
      expect(skipReason(ev, scope)).toBe("classic-vine");
    }
  });
  it("classifies a platform=vine event without an l tag as vine", () => {
    const ev = withTags(first, (t) => [...t, ["platform", "vine"]]);
    expect(classOf(ev)).toBe("vine");
  });
  it("classifies a user-submitted archive event and skips it", () => {
    const ev = withTags(vine[0]!, (t) => [...t, ["l", "user-submitted", "archive.divine.video"]]);
    expect(classOf(ev)).toBe("user-submitted");
    expect(skipReason(ev, scope)).toBe("user-submitted");
  });
  it("lets includeVines switch rule 2 off", () => {
    expect(skipReason(vine[0]!, { includeVines: true })).not.toBe("classic-vine");
    const us = withTags(vine[0]!, (t) => [...t, ["l", "user-submitted"]]);
    expect(skipReason(us, { includeVines: true })).not.toBe("user-submitted");
  });
});

describe("imeta", () => {
  it("parses the first imeta tag, splitting at the first space", () => {
    const m = imeta(first)!;
    expect(m.m).toBe("video/mp4");
    expect(m.x).toBe(first.tags.find((t) => t[0] === "d")![1]);
    expect(m.url).toMatch(/^https:\/\/media\.divine\.video\//);
  });
  it("keeps spaces inside values and uses the first tag only", () => {
    const ev = withTags(first, () => [
      ["imeta", "alt a b  c", "x aa"],
      ["imeta", "x bb"],
    ]);
    expect(imeta(ev)).toEqual({ alt: "a b  c", x: "aa" });
  });
  it("returns undefined without an imeta tag", () => {
    expect(imeta(withTags(first, (t) => t.filter((x) => x[0] !== "imeta")))).toBeUndefined();
  });
});

describe("titleOf", () => {
  it("uses the title, trimmed", () => {
    expect(titleOf(setTag(first, "title", "  Hello  "))).toBe("Hello");
  });
  it("falls back to the first non-empty summary line", () => {
    let ev = setTag(first, "title", "");
    ev = setTag(ev, "summary", "\n  first line \nsecond");
    expect(titleOf(ev)).toBe("first line");
  });
  it("is undefined for a whitespace-only title and an empty summary", () => {
    let ev = setTag(first, "title", "   \t");
    ev = setTag(ev, "summary", "");
    expect(titleOf(ev)).toBeUndefined();
    expect(skipReason(ev, scope)).toBe("no-title");
  });
  it("is undefined when neither tag exists", () => {
    const ev = withTags(first, (t) => t.filter((x) => x[0] !== "title" && x[0] !== "summary"));
    expect(titleOf(ev)).toBeUndefined();
  });
  it("keeps Unicode verbatim", () => {
    expect(titleOf(setTag(first, "title", " 日本語 ✨ Ünï "))).toBe("日本語 ✨ Ünï");
  });
});

describe("skipReason", () => {
  it("gives the native fixtures only the expected skip reasons", () => {
    const counts: Record<string, number> = {};
    for (const ev of native) {
      const r = skipReason(ev, scope) ?? "eligible";
      counts[r] = (counts[r] ?? 0) + 1;
    }
    expect(counts).toEqual({ eligible: 46, "no-title": 3, expiration: 1 });
  });
  it("no-imeta", () => {
    expect(skipReason(withTags(first, (t) => t.filter((x) => x[0] !== "imeta")), scope)).toBe("no-imeta");
  });
  it("no-d when the d tag is missing, empty or only whitespace", () => {
    expect(skipReason(withTags(first, (t) => t.filter((x) => x[0] !== "d")), scope)).toBe("no-d");
    expect(skipReason(setTag(first, "d", ""), scope)).toBe("no-d");
    expect(skipReason(setTag(first, "d", " \t "), scope)).toBe("no-d");
    expect(skipReason(withTags(first, (t) => [...t.filter((x) => x[0] !== "d"), ["d"]]), scope)).toBe("no-d");
  });
  it("no-d comes right after scope and before every other rule", () => {
    const noD = withTags(first, (t) => t.filter((x) => x[0] !== "d" && x[0] !== "imeta"));
    expect(skipReason(noD, scope)).toBe("no-d");
    const vineNoD = withTags(vine[0]!, (t) => t.filter((x) => x[0] !== "d"));
    expect(skipReason(vineNoD, scope)).toBe("classic-vine");
  });
  it("bad-d when the d holds a control character or a line or paragraph separator", () => {
    const d = first.tags.find((t) => t[0] === "d")![1]!;
    for (const bad of ["\n", "\r", " ", " ", "\u0000", "\u007f", "\u0085"]) {
      expect(skipReason(setTag(first, "d", `${d}${bad}x`), scope)).toBe("bad-d");
    }
    expect(skipReason(setTag(first, "d", `${d} é ✓`), scope)).toBeNull();
  });
  it("bad-sha256", () => {
    const x = imeta(first)!.x!;
    expect(skipReason(setImeta(first, "x", x.slice(0, 63)), scope)).toBe("bad-sha256");
    expect(skipReason(setImeta(first, "x", x.toUpperCase()), scope)).toBe("bad-sha256");
    expect(skipReason(setImeta(first, "x", "g".repeat(64)), scope)).toBe("bad-sha256");
  });
  it("bad-sha256 when x is missing", () => {
    const ev = withTags(first, (t) =>
      t.map((x) => (x[0] === "imeta" ? x.filter((e) => !e.startsWith("x ")) : x)),
    );
    expect(skipReason(ev, scope)).toBe("bad-sha256");
  });
  it("not-mp4", () => {
    expect(skipReason(setImeta(first, "m", "video/webm"), scope)).toBe("not-mp4");
  });
  it("content-warning tag", () => {
    expect(skipReason(withTags(first, (t) => [...t, ["content-warning", "nudity"]]), scope)).toBe("content-warning");
    expect(skipReason(withTags(first, (t) => [...t, ["content-warning"]]), scope)).toBe("content-warning");
  });
  it("content-warning namespace", () => {
    const ev = withTags(first, (t) => [...t, ["L", "content-warning"], ["l", "nudity", "content-warning"]]);
    expect(skipReason(ev, scope)).toBe("content-warning");
  });
  it("expiration", () => {
    expect(skipReason(withTags(first, (t) => [...t, ["expiration", "1794237864"]]), scope)).toBe("expiration");
  });
  it("checks rules in order", () => {
    // imeta missing outranks a missing title, a content warning and an expiration
    let ev = withTags(first, (t) => t.filter((x) => x[0] !== "imeta" && x[0] !== "title" && x[0] !== "summary"));
    ev = withTags(ev, (t) => [...t, ["content-warning", "x"], ["expiration", "1"]]);
    expect(skipReason(ev, scope)).toBe("no-imeta");
    ev = withTags(first, (t) => [...t.filter((x) => x[0] !== "title" && x[0] !== "summary"), ["content-warning", "x"], ["expiration", "1"]]);
    expect(skipReason(ev, scope)).toBe("no-title");
    ev = withTags(first, (t) => [...t, ["content-warning", "x"], ["expiration", "1"]]);
    expect(skipReason(ev, scope)).toBe("content-warning");
  });
});

describe("slim", () => {
  const heavy = new Set(["proofmode", "device_attestation", "c2pa_manifest_id"]);
  it("drops the heavy tags and keeps every other tag in order", () => {
    const s = slim(first);
    expect(s.tags).toEqual(first.tags.filter((t) => !heavy.has(t[0]!)));
    expect(first.tags.some((t) => heavy.has(t[0]!))).toBe(true);
    expect(s.id).toBe(first.id);
    expect(s.sig).toBe(first.sig);
    expect(s.content).toBe(first.content);
  });
  it("is under 3 KB for the first native fixture", () => {
    expect(JSON.stringify(slim(first)).length).toBeLessThan(3072);
  });
  it("does not mutate its input", () => {
    const before = JSON.stringify(first);
    slim(first);
    expect(JSON.stringify(first)).toBe(before);
  });
});
