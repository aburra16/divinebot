import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deletionFor } from "../src/deletion.js";
import { changedFields, contentHash, diffItems, parseTags, summarizeChanges, type LiveItem as DiffLiveItem } from "../src/diff.js";
import type { Tags } from "../src/tags.js";

const CURATOR = "6b279fb268a564ef74f35533f58a165fd4846b9c5595ac0bfc38cab37fda559d";

function item(d: string, name = "X"): Tags {
  return [
    ["d", d],
    ["name", name],
  ];
}

/** A live item as state records it: what the diff reads, plus the `d` and latest event id. */
interface LiveItem extends DiffLiveItem {
  d: string;
  latestEventId: string;
}

function liveOf(tags: Tags, latestEventId = "e1"): LiveItem {
  const d = tags[0]?.[1] ?? "";
  return { d, contentHash: contentHash(tags), tagsJson: JSON.stringify(tags), latestEventId };
}

const builtMap = (...items: Tags[]) => new Map(items.map((t) => [t[0]?.[1] ?? "", t]));
const liveMap = (...items: LiveItem[]) => new Map(items.map((l) => [l.d, l]));

describe("contentHash", () => {
  it("is the sha256 hex of JSON.stringify(tags)", () => {
    const tags = item("divine-p-v1");
    const expected = createHash("sha256").update(JSON.stringify(tags)).digest("hex");
    expect(contentHash(tags)).toBe(expected);
    expect(contentHash(tags)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a value or the tag order changes", () => {
    const a = item("divine-p-v1", "A");
    expect(contentHash(a)).not.toBe(contentHash(item("divine-p-v1", "B")));
    expect(contentHash(a)).not.toBe(contentHash([a[1]!, a[0]!]));
  });
});

describe("diffItems", () => {
  it("identical tags → unchanged", () => {
    const tags = item("divine-p-v1");
    const diff = diffItems(builtMap(tags), liveMap(liveOf(tags)), { detectGone: true });
    expect(diff).toEqual({ created: [], changed: [], unchanged: 1, gone: [] });
  });

  it("changed value → changed", () => {
    const now = item("divine-p-v1", "New name");
    const diff = diffItems(builtMap(now), liveMap(liveOf(item("divine-p-v1", "Old name"))), {
      detectGone: true,
    });
    expect(diff).toEqual({ created: [], changed: [now], unchanged: 0, gone: [] });
  });

  it("new d → created", () => {
    const tags = item("divine-p-v2");
    const diff = diffItems(builtMap(tags), liveMap(liveOf(item("divine-p-v1"))), { detectGone: false });
    expect(diff.created).toEqual([tags]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(0);
  });

  it("detectGone true: live d absent from built → gone", () => {
    const kept = item("divine-p-v1");
    const diff = diffItems(
      builtMap(kept),
      liveMap(liveOf(kept), liveOf(item("divine-p-v9")), liveOf(item("divine-p-v3"))),
      { detectGone: true },
    );
    expect(diff.gone).toEqual(["divine-p-v3", "divine-p-v9"]);
    expect(diff.unchanged).toBe(1);
  });

  it("detectGone false: nothing is gone", () => {
    const kept = item("divine-p-v1");
    const diff = diffItems(builtMap(kept), liveMap(liveOf(kept), liveOf(item("divine-p-v9"))), {
      detectGone: false,
    });
    expect(diff.gone).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("never calls a held d gone: its record is still in the fetch, only malformed", () => {
    const kept = item("divine-p-v1");
    const diff = diffItems(
      builtMap(kept),
      liveMap(liveOf(kept), liveOf(item("divine-p-v7")), liveOf(item("divine-p-v9"))),
      { detectGone: true, held: new Set(["divine-p-v7"]) },
    );
    expect(diff.gone).toEqual(["divine-p-v9"]);
  });

  it("returns created and changed sorted by d, whatever the map order", () => {
    const c = [item("divine-p-v3"), item("divine-p-v1"), item("divine-p-v2")];
    const ch = [item("divine-p-w9", "new"), item("divine-p-w1", "new")];
    const diff = diffItems(
      builtMap(...c, ...ch),
      liveMap(liveOf(item("divine-p-w9", "old")), liveOf(item("divine-p-w1", "old"))),
      { detectGone: true },
    );
    expect(diff.created.map((t) => t[0]?.[1])).toEqual(["divine-p-v1", "divine-p-v2", "divine-p-v3"]);
    expect(diff.changed.map((t) => t[0]?.[1])).toEqual(["divine-p-w1", "divine-p-w9"]);
  });
});

describe("deletionFor", () => {
  it("deletionFor lists every version", () => {
    const del = deletionFor("divine-p-v1", ["id1", "id2"], CURATOR);
    expect(del).toEqual({
      kind: 5,
      tags: [
        ["e", "id1"],
        ["e", "id2"],
        ["a", `39999:${CURATOR}:divine-p-v1`],
        ["k", "39999"],
      ],
      content: "",
    });
  });

  it("names a repeated id once, keeping the first position", () => {
    const del = deletionFor("divine-p-v1", ["id1", "id2", "id1"], CURATOR);
    expect(del.tags.filter((t) => t[0] === "e")).toEqual([
      ["e", "id1"],
      ["e", "id2"],
    ]);
  });

  it("refuses to build a deletion with no version ids", () => {
    expect(() => deletionFor("divine-p-v1", [], CURATOR)).toThrow(/no event ids/);
  });
});

describe("parseTags", () => {
  it("reads stored tags JSON", () => {
    expect(parseTags('[["d","a"],["t","x"],["t","y"]]')).toEqual([["d", "a"], ["t", "x"], ["t", "y"]]);
  });

  it("reads text that is not a list of string tags as no tags", () => {
    expect(parseTags("not json")).toEqual([]);
    expect(parseTags('{"d":"a"}')).toEqual([]);
    expect(parseTags('[["d","a"],"loose",["n",1],["ok","v"]]')).toEqual([["d", "a"], ["ok", "v"]]);
  });
});

describe("changedFields", () => {
  it("names the tags whose values differ, sorted", () => {
    const before: Tags = [["d", "a"], ["name", "Old"], ["views", "1"], ["caption", "x"]];
    const after: Tags = [["d", "a"], ["name", "New"], ["views", "1"], ["caption", "y"]];
    expect(changedFields(before, after)).toEqual(["caption", "name"]);
  });

  it("counts an added tag and a removed tag as differing", () => {
    const before: Tags = [["d", "a"], ["views", "1"]];
    const after: Tags = [["d", "a"], ["watch", "https://x"]];
    expect(changedFields(before, after)).toEqual(["views", "watch"]);
  });

  it("compares a repeated tag as a group, in order", () => {
    const same: Tags = [["d", "a"], ["t", "comedy"], ["t", "vine"]];
    expect(changedFields(same, [...same])).toEqual([]);
    expect(changedFields(same, [["d", "a"], ["t", "comedy"], ["t", "vine"], ["t", "loops"]])).toEqual(["t"]);
    expect(changedFields(same, [["d", "a"], ["t", "vine"], ["t", "comedy"]])).toEqual(["t"]);
  });

  it("is empty for identical tags, whatever order the tag names appear in", () => {
    expect(changedFields([["d", "a"], ["name", "N"]], [["name", "N"], ["d", "a"]])).toEqual([]);
  });
});

describe("summarizeChanges", () => {
  const video = (n: number, extra: Tags = []): Tags => [["d", `divine-p-v${n}`], ["name", `Video ${n}`], ...extra];
  const liveFor = (...items: Tags[]) => liveMap(...items.map((t) => liveOf(t)));

  it("counts, per tag, the changed items where it differs: caption on 3 items and views on 1", () => {
    const old = [1, 2, 3, 4, 5].map((n) => video(n, [["caption", "first caption"], ["views", "555"]]));
    const now = old.map((tags, i) =>
      i < 3 ? video(i + 1, [["caption", "second caption"], ["views", "555"]])
      : i === 3 ? video(4, [["caption", "first caption"], ["views", "556"]])
      : tags,
    );
    const changed = now.filter((tags, i) => JSON.stringify(tags) !== JSON.stringify(old[i]));

    const summary = summarizeChanges(changed, liveFor(...old));

    expect(summary.counts).toEqual([
      { field: "caption", items: 3 },
      { field: "views", items: 1 },
    ]);
  });

  it("counts added, removed and modified as differing, most items first and ties by name", () => {
    const old = [video(1, [["views", "1"]]), video(2, [["watch", "w"]]), video(3)];
    const now = [video(1, [["views", "2"]]), video(2), video(3, [["watch", "w"]])];

    const { counts } = summarizeChanges(now, liveFor(...old));

    expect(counts).toEqual([
      { field: "watch", items: 2 }, // removed from 2, added to 3
      { field: "views", items: 1 },
    ]);
  });

  it("lists the first 10 changed items as examples with d, name and the changed tag names", () => {
    const old = Array.from({ length: 12 }, (_, i) => video(i + 100, [["views", "1"], ["caption", "a"]]));
    const now = old.map((tags, i) => (i === 0 ? video(100, [["views", "2"], ["caption", "b"]]) : video(i + 100, [["views", "2"], ["caption", "a"]])));

    const summary = summarizeChanges(now, liveFor(...old));

    expect(summary.examples).toHaveLength(10);
    expect(summary.examples[0]).toEqual({ d: "divine-p-v100", name: "Video 100", fields: ["caption", "views"] });
    expect(summary.examples[1]).toEqual({ d: "divine-p-v101", name: "Video 101", fields: ["views"] });
    expect(summary.examples.map((e) => e.d)).toEqual(now.slice(0, 10).map((t) => t[0]![1]));
    expect(summary.counts).toEqual([
      { field: "views", items: 12 },
      { field: "caption", items: 1 },
    ]);
    expect(summarizeChanges(now, liveFor(...old), 3).examples).toHaveLength(3);
  });

  it("takes the name from the new tags, and leaves it out when the item has none", () => {
    const summary = summarizeChanges([[["d", "divine-p-v1"], ["views", "2"]]], liveFor([["d", "divine-p-v1"], ["views", "1"]]));
    expect(summary.examples).toEqual([{ d: "divine-p-v1", fields: ["views"] }]);
  });

  it("treats an item whose live tags are unreadable as changed in every tag", () => {
    const live = liveMap({ d: "divine-p-v1", contentHash: "h", tagsJson: "garbage", latestEventId: "e" });
    const summary = summarizeChanges([video(1, [["views", "1"]])], live);
    expect(summary.counts.map((c) => c.field)).toEqual(["d", "name", "views"]);
  });

  it("is empty when nothing changed", () => {
    expect(summarizeChanges([], liveMap())).toEqual({ counts: [], examples: [] });
  });
});
