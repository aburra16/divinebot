import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools/core";
import { buildItem, itemD, type ItemContext } from "../src/item.js";
import { tagValue, type Tags } from "../src/tags.js";

function load(name: string): NostrEvent[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as NostrEvent);
}

const native = load("native").find((e) => e.id.startsWith("ae26388c"))!;
const vine = load("vine").find((e) => e.id.startsWith("8e0d6495"))!;
const golden = JSON.parse(readFileSync(new URL("../header/example-items.json", import.meta.url), "utf8")) as {
  kind: number;
  content: string;
  tags: Tags;
}[];
const goldenNative = golden[0]!;
const goldenVine = golden[1]!;

const headerCoordinate = tagValue(goldenNative.tags, "z")!;
const mediaBase = "https://media.divine.video";

function ctxFor(item: { tags: Tags }, withCreator: boolean): ItemContext {
  return {
    headerCoordinate,
    mediaBase,
    creator: withCreator ? tagValue(item.tags, "creator") : undefined,
    nip05: tagValue(item.tags, "creator-nip05"),
  };
}

const ctx: ItemContext = { headerCoordinate, mediaBase, creator: "Ada" };

function withTags(ev: NostrEvent, f: (tags: string[][]) => string[][]): NostrEvent {
  return { ...ev, tags: f(ev.tags.map((t) => [...t])) };
}
function dropTag(ev: NostrEvent, name: string): NostrEvent {
  return withTags(ev, (tags) => tags.filter((t) => t[0] !== name));
}
function setTag(ev: NostrEvent, name: string, ...values: string[]): NostrEvent {
  return withTags(ev, (tags) => [...tags.filter((t) => t[0] !== name), [name, ...values]]);
}
function names(tags: Tags): string[] {
  return tags.map((t) => t[0]!);
}

describe("buildItem against the reviewed examples", () => {
  it("reproduces the native item exactly", () => {
    expect(buildItem(native, ctxFor(goldenNative, true))).toEqual(goldenNative.tags);
  });

  it("reproduces the Vine item exactly, taking the creator from the author tag", () => {
    const tags = buildItem(vine, ctxFor(goldenVine, false));
    expect(tags).toEqual(goldenVine.tags);
    expect(tagValue(tags, "creator")).toBe(tagValue(vine.tags, "author"));
  });

  it("builds one z tag and a d tag from itemD", () => {
    const tags = buildItem(native, ctxFor(goldenNative, true));
    expect(tags.filter((t) => t[0] === "z")).toHaveLength(1);
    expect(tagValue(tags, "d")).toBe(itemD(native));
    expect(itemD(native)).toBe(`divine-${native.pubkey}-${tagValue(native.tags, "d")}`);
  });
});

describe("buildItem fallbacks", () => {
  it("omits the thumbnail when imeta has no image or a non-https image", () => {
    const noImage = withTags(native, (tags) =>
      tags.map((t) => (t[0] === "imeta" ? t.filter((e) => !e.startsWith("image ")) : t)),
    );
    expect(tagValue(buildItem(noImage, ctx), "thumbnail")).toBeUndefined();
    const http = withTags(native, (tags) =>
      tags.map((t) => (t[0] === "imeta" ? t.map((e) => (e.startsWith("image ") ? "image http://x.test/a.jpg" : e)) : t)),
    );
    expect(tagValue(buildItem(http, ctx), "thumbnail")).toBeUndefined();
  });

  it("publishes the created_at date when published_at is missing", () => {
    const tags = buildItem(dropTag(native, "published_at"), ctx);
    expect(tagValue(tags, "published")).toBe("2026-10-09");
    const early = { ...dropTag(native, "published_at"), created_at: 1451606399 };
    expect(tagValue(buildItem(early, ctx), "published")).toBe("2015-12-31");
    const lateUtc = { ...dropTag(native, "published_at"), created_at: 1451606400 };
    expect(tagValue(buildItem(lateUtc, ctx), "published")).toBe("2016-01-01");
  });

  it("uses the duration tag when imeta has none, and omits it when neither exists", () => {
    expect(tagValue(buildItem(native, ctx), "duration")).toBe("6");
    expect(tagValue(buildItem(setTag(native, "duration", "9"), ctx), "duration")).toBe("9");
    expect(tagValue(buildItem(dropTag(native, "duration"), ctx), "duration")).toBeUndefined();
  });

  it("prefers imeta duration over the duration tag", () => {
    const ev = withTags(setTag(native, "duration", "9"), (tags) =>
      tags.map((t) => (t[0] === "imeta" ? [...t, "duration 4.5"] : t)),
    );
    expect(tagValue(buildItem(ev, ctx), "duration")).toBe("4.5");
  });

  it("omits the description when it equals the title and keeps it when it differs", () => {
    expect(tagValue(buildItem(native, ctx), "description")).toBe("It’s called “28 Days Later”\n#mrdavisux");
    const same = setTag(native, "summary", "  Writing a song for my boy Slop \n");
    expect(tagValue(buildItem(same, ctx), "description")).toBeUndefined();
    expect(tagValue(buildItem(dropTag(native, "summary"), ctx), "description")).toBeUndefined();
  });

  it("includes language and verification when present, in spec order", () => {
    const ev = withTags(native, (tags) => [...tags, ["l", "fr", "ISO-639-1"], ["l", "x", "other"]]);
    const out = buildItem(ev, ctx);
    expect(tagValue(out, "language")).toBe("fr");
    const n = names(out);
    expect(n.indexOf("platform")).toBeLessThan(n.indexOf("language"));
    expect(n.indexOf("language")).toBeLessThan(n.indexOf("verification"));
    expect(n.indexOf("verification")).toBeLessThan(n.indexOf("a"));
    expect(tagValue(buildItem(dropTag(native, "verification"), ctx), "verification")).toBeUndefined();
  });

  it("writes vine-only fields only for class vine", () => {
    const nativeNames = names(buildItem(native, ctx));
    for (const n of ["vine-creator-id", "vine-loops", "vine-likes"]) expect(nativeNames).not.toContain(n);
    expect(tagValue(buildItem(native, ctx), "platform")).toBe("divine");
    const out = buildItem(vine, { headerCoordinate, mediaBase });
    expect(tagValue(out, "platform")).toBe("vine");
    expect(tagValue(out, "vine-loops")).toBe("105");
  });
});

describe("hashtags", () => {
  it("is divine, then hashtags lowercased and deduped in order", () => {
    const ev = withTags(native, (tags) => [
      ...tags.filter((t) => t[0] !== "t"),
      ["t", "Zeta"],
      ["t", "alpha"],
      ["t", "ZETA"],
      ["t", "Divine"],
      ["t", " "],
      ["t", "alpha "],
    ]);
    expect(buildItem(ev, ctx).filter((t) => t[0] === "t")).toEqual([["t", "divine"], ["t", "zeta"], ["t", "alpha"]]);
  });

  it("is only divine when there are no hashtags", () => {
    expect(buildItem(dropTag(native, "t"), ctx).filter((t) => t[0] === "t")).toEqual([["t", "divine"]]);
  });

  it("puts vine right after divine for class vine without duplicating it", () => {
    const ev = withTags(vine, (tags) => [...tags, ["t", "Vine"]]);
    const ts = buildItem(ev, { headerCoordinate, mediaBase })
      .filter((t) => t[0] === "t")
      .map((t) => t[1]);
    expect(ts.slice(0, 3)).toEqual(["divine", "vine", "looniebin"]);
    expect(ts.filter((x) => x === "vine")).toHaveLength(1);
  });
});

describe("messy creator text", () => {
  it("keeps a 400-character title whole", () => {
    const long = "x".repeat(400);
    const tags = buildItem(setTag(native, "title", long), ctx);
    expect(tagValue(tags, "title")).toBe(long);
    expect(tagValue(tags, "alt")).toBe(`Divine video: ${long} by Ada`);
  });

  it("takes the first non-empty line of the summary when the title is blank", () => {
    const ev = setTag(setTag(native, "title", "   \t "), "summary", "\n  \n  First line  \nSecond line");
    const tags = buildItem(ev, ctx);
    expect(tagValue(tags, "title")).toBe("First line");
    expect(tagValue(tags, "description")).toBe("First line  \nSecond line");
  });

  it("trims the creator and drops a whitespace-only creator", () => {
    expect(tagValue(buildItem(native, { ...ctx, creator: "  Ada  " }), "creator")).toBe("Ada");
    const blank = buildItem(native, { ...ctx, creator: "   " });
    expect(tagValue(blank, "creator")).toBeUndefined();
    expect(tagValue(blank, "alt")).toBe("Divine video: Writing a song for my boy Slop");
  });

  it("writes alt without a creator as Divine video: <title>", () => {
    const tags = buildItem(native, { headerCoordinate, mediaBase });
    expect(tagValue(tags, "alt")).toBe("Divine video: Writing a song for my boy Slop");
    expect(tagValue(tags, "creator")).toBeUndefined();
  });

  it("drops a blank Vine author and a blank nip05", () => {
    const ev = setTag(vine, "author", "  ");
    const tags = buildItem(ev, { headerCoordinate, mediaBase, nip05: "  " });
    expect(tagValue(tags, "creator")).toBeUndefined();
    expect(tagValue(tags, "creator-nip05")).toBeUndefined();
  });

  it("keeps Unicode verbatim", () => {
    const name = "𝖎𝖒𝖗𝖉𝖆𝖛𝖎𝖎𝖘 💀 é́";
    expect(tagValue(buildItem(native, { ...ctx, creator: name }), "creator")).toBe(name);
  });

  it("never writes an empty value", () => {
    const messy = withTags(native, (tags) => [
      ...tags.filter((t) => !["summary", "duration", "verification", "t"].includes(t[0]!)),
      ["summary", "   "],
      ["duration", ""],
      ["verification", ""],
      ["t", ""],
    ]);
    for (const ev of [messy, native, vine]) {
      for (const tag of buildItem(ev, { headerCoordinate, mediaBase, creator: " ", nip05: "" })) {
        expect(tag.length).toBeGreaterThanOrEqual(2);
        for (const v of tag) expect(v).not.toBe("");
      }
    }
  });
});
